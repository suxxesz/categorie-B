/**
 * Отчёт по договорам: аванс, выплачено, остаток — на заданную дату.
 *
 * Деньги считаются целыми копейками (bigint) — без float, до копейки.
 * Запуск:   npx tsx report.ts --date 2026-11-10 [--csv report.csv]
 * По умолчанию дата = 2026-11-10 (контрольная дата из задания).
 *
 * Логика и принятые решения подробно описаны в ../DECISIONS.md
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Деньги: целые копейки в bigint. Никаких float.
// ---------------------------------------------------------------------------

/** "300000.00" -> 30000000n копеек. Пустая строка -> 0n. */
function parseMoney(s: string): bigint {
  const v = (s ?? "").trim();
  if (v === "") return 0n;
  const neg = v.startsWith("-");
  const body = neg ? v.slice(1) : v;
  const [intPart, fracRaw = ""] = body.split(".");
  const frac = (fracRaw + "00").slice(0, 2); // ровно 2 знака
  const kopecks = BigInt(intPart || "0") * 100n + BigInt(frac || "0");
  return neg ? -kopecks : kopecks;
}

/** 30000000n -> "300 000,00". */
function formatMoney(k: bigint): string {
  const neg = k < 0n;
  const abs = neg ? -k : k;
  const rub = abs / 100n;
  const kop = abs % 100n;
  const rubStr = rub
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " "); // разряды по 3
  const kopStr = kop.toString().padStart(2, "0");
  return `${neg ? "-" : ""}${rubStr},${kopStr}`;
}

// ---------------------------------------------------------------------------
// Разбор CSV (с учётом кавычек и запятых внутри полей).
// ---------------------------------------------------------------------------

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((x) => x.trim() !== ""));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => (obj[h] = (r[idx] ?? "").trim()));
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Доменные типы.
// ---------------------------------------------------------------------------

type WorkStatusAsOf = "done" | "planned" | "cancelled";

interface Contract {
  contract_id: string;
  contractor: string;
  amount: bigint;
  signed_at: string;
}

interface Work {
  work_id: string;
  contract_id: string;
  title: string;
  price: bigint;
  rawStatus: string;
  completed_at: string;
  cancelled_at: string;
  // вычисляется:
  statusAsOf: WorkStatusAsOf;
  directPaid: bigint; // прямые платежи на эту работу (нетто, на дату)
  allocated: bigint; // разнесённый общий аванс
  paid: bigint; // directPaid + allocated
  remaining: bigint; // 0 для отменённых
}

interface Payment {
  payment_id: string;
  contract_id: string;
  work_id: string;
  purpose: string;
  amount: bigint;
  status: string;
  created_at: string;
  paid_at: string;
  refunded_at: string;
}

/** Дата в формате YYYY-MM-DD сравнивается как строка (нули дополнены). */
function on(dateStr: string, asOf: string): boolean {
  return dateStr !== "" && dateStr <= asOf;
}

// ---------------------------------------------------------------------------
// Расчёт.
// ---------------------------------------------------------------------------

function statusAsOf(w: { completed_at: string; cancelled_at: string }, asOf: string): WorkStatusAsOf {
  if (on(w.cancelled_at, asOf)) return "cancelled";
  if (on(w.completed_at, asOf)) return "done";
  return "planned";
}

/** Нетто-выплата по платежу на дату: ушло минус вернулось. */
function netPaid(p: Payment, asOf: string): bigint {
  const out = on(p.paid_at, asOf) ? p.amount : 0n;
  const back = p.status === "refunded" && on(p.refunded_at, asOf) ? p.amount : 0n;
  return out - back;
}

/** Платёж ещё в пути на дату (заведён/в очереди, но деньги не ушли). */
function isPending(p: Payment, asOf: string): boolean {
  return !on(p.paid_at, asOf);
}

interface ContractReport {
  contract: Contract;
  works: Work[];
  billable: bigint; // сумма цен не отменённых работ
  paidNet: bigint; // всего выплачено нетто на дату
  unallocatedAdvance: bigint; // аванс, не разнесённый на принятые работы
  remaining: bigint; // billable - paidNet (может быть < 0 = переплата)
  pending: { payment: Payment; amount: bigint }[];
  notes: string[];
}

function build(
  contracts: Contract[],
  works: Work[],
  payments: Payment[],
  asOf: string
): ContractReport[] {
  const byContract = new Map<string, ContractReport>();

  for (const c of contracts) {
    byContract.set(c.contract_id, {
      contract: c,
      works: [],
      billable: 0n,
      paidNet: 0n,
      unallocatedAdvance: 0n,
      remaining: 0n,
      pending: [],
      notes: [],
    });
  }

  // работы
  for (const w of works) {
    w.statusAsOf = statusAsOf(w, asOf);
    w.directPaid = 0n;
    w.allocated = 0n;
    w.paid = 0n;
    w.remaining = 0n;
    byContract.get(w.contract_id)?.works.push(w);
  }

  // платежи: прямые -> на работу, общие -> в пул договора
  const poolByContract = new Map<string, bigint>();
  for (const p of payments) {
    const rep = byContract.get(p.contract_id);
    if (!rep) continue;

    if (isPending(p, asOf)) {
      const willPay = p.status === "refunded" ? 0n : p.amount;
      if (willPay > 0n) rep.pending.push({ payment: p, amount: willPay });
      continue;
    }

    const net = netPaid(p, asOf);
    rep.paidNet += net;

    if (p.work_id !== "") {
      const w = rep.works.find((x) => x.work_id === p.work_id);
      if (w) w.directPaid += net;
      else poolByContract.set(p.contract_id, (poolByContract.get(p.contract_id) ?? 0n) + net);
    } else {
      poolByContract.set(p.contract_id, (poolByContract.get(p.contract_id) ?? 0n) + net);
    }
  }

  // разнесение общего пула на ПРИНЯТЫЕ работы по дате приёмки
  for (const rep of byContract.values()) {
    let pool = poolByContract.get(rep.contract.contract_id) ?? 0n;

    const doneWorks = rep.works
      .filter((w) => w.statusAsOf === "done")
      .sort((a, b) =>
        a.completed_at === b.completed_at
          ? a.work_id.localeCompare(b.work_id)
          : a.completed_at.localeCompare(b.completed_at)
      );

    for (const w of doneWorks) {
      const need = w.price - w.directPaid;
      if (need > 0n && pool > 0n) {
        const give = need < pool ? need : pool;
        w.allocated += give;
        pool -= give;
      }
    }
    rep.unallocatedAdvance = pool;

    // итоги по работам
    for (const w of rep.works) {
      w.paid = w.directPaid + w.allocated;
      w.remaining = w.statusAsOf === "cancelled" ? 0n : max(w.price - w.paid, 0n);
      if (w.statusAsOf !== "cancelled") rep.billable += w.price;
    }

    rep.remaining = rep.billable - rep.paidNet;

    // заметки / флаги
    const cancelledSum = rep.works
      .filter((w) => w.statusAsOf === "cancelled")
      .reduce((s, w) => s + w.price, 0n);
    if (rep.contract.amount !== rep.billable) {
      rep.notes.push(
        `Сумма договора ${formatMoney(rep.contract.amount)} ₽ не равна сумме не отменённых работ ${formatMoney(
          rep.billable
        )} ₽` + (cancelledSum > 0n ? ` (отменено работ на ${formatMoney(cancelledSum)} ₽).` : ".")
      );
    }
    if (rep.remaining < 0n) {
      rep.notes.push(`Переплата на дату: ${formatMoney(-rep.remaining)} ₽.`);
    }
    if (rep.unallocatedAdvance > 0n) {
      rep.notes.push(
        `Аванс ${formatMoney(rep.unallocatedAdvance)} ₽ уплачен, но ещё не закрыт принятыми работами.`
      );
    }
  }

  return [...byContract.values()];
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

// ---------------------------------------------------------------------------
// Вывод.
// ---------------------------------------------------------------------------

const STATUS_RU: Record<WorkStatusAsOf, string> = {
  done: "принята",
  planned: "в плане",
  cancelled: "отменена",
};

function pad(s: string, n: number): string {
  // длина в «символах»; достаточно для нашей таблицы
  const len = [...s].length;
  return len >= n ? s : s + " ".repeat(n - len);
}
function padLeft(s: string, n: number): string {
  const len = [...s].length;
  return len >= n ? s : " ".repeat(n - len) + s;
}

function renderText(reports: ContractReport[], asOf: string): string {
  const out: string[] = [];
  out.push("═".repeat(78));
  out.push(`ОТЧЁТ ПО ДОГОВОРАМ НА ДАТУ ${asOf}`);
  out.push("Суммы в рублях. Выплачено = ушло минус возвраты, только платежи до указанной даты.");
  out.push("═".repeat(78));

  let gBillable = 0n;
  let gPaid = 0n;
  let gRemaining = 0n;

  for (const r of reports.sort((a, b) => a.contract.contract_id.localeCompare(b.contract.contract_id))) {
    out.push("");
    out.push(`Договор ${r.contract.contract_id} — ${r.contract.contractor}`);
    out.push(
      `  подписан ${r.contract.signed_at}, сумма договора ${formatMoney(r.contract.amount)} ₽`
    );
    out.push("");
    out.push(
      "  " +
        pad("Работа", 8) +
        pad("Название", 30) +
        pad("Статус", 10) +
        padLeft("Цена", 13) +
        padLeft("Выплачено", 14) +
        padLeft("Остаток", 13)
    );
    out.push("  " + "─".repeat(86));

    for (const w of r.works.sort((a, b) => a.work_id.localeCompare(b.work_id))) {
      out.push(
        "  " +
          pad(w.work_id, 8) +
          pad(w.title.length > 28 ? w.title.slice(0, 27) + "…" : w.title, 30) +
          pad(STATUS_RU[w.statusAsOf], 10) +
          padLeft(formatMoney(w.price), 13) +
          padLeft(formatMoney(w.paid), 14) +
          padLeft(w.statusAsOf === "cancelled" ? "—" : formatMoney(w.remaining), 13)
      );
    }

    out.push("  " + "─".repeat(86));
    out.push(
      "  " +
        pad("ИТОГО по договору (не отменённые работы):", 48) +
        padLeft(formatMoney(r.billable), 13) +
        padLeft(formatMoney(r.paidNet), 14) +
        padLeft(formatMoney(r.remaining), 13)
    );

    if (r.unallocatedAdvance > 0n) {
      out.push(`     из выплат не закрыто работами (аванс): ${formatMoney(r.unallocatedAdvance)} ₽`);
    }
    if (r.pending.length) {
      const sum = r.pending.reduce((s, p) => s + p.amount, 0n);
      out.push(
        `     в очереди на оплату (ещё не ушли): ${formatMoney(sum)} ₽ — ` +
          r.pending.map((p) => `${p.payment.payment_id} ${formatMoney(p.amount)}`).join(", ")
      );
    }
    for (const n of r.notes) out.push(`     ⚠ ${n}`);

    gBillable += r.billable;
    gPaid += r.paidNet;
    gRemaining += r.remaining;
  }

  out.push("");
  out.push("═".repeat(78));
  out.push(
    `ВСЕГО: к оплате по работам ${formatMoney(gBillable)} ₽ | ` +
      `выплачено ${formatMoney(gPaid)} ₽ | остаток ${formatMoney(gRemaining)} ₽`
  );
  out.push("═".repeat(78));
  return out.join("\n");
}

function renderCsv(reports: ContractReport[], asOf: string): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const money = (k: bigint) => (Number(k) / 100).toFixed(2); // только для CSV-вывода, расчёт уже сделан в bigint
  const lines: string[] = [];
  lines.push(`# отчёт на дату ${asOf}`);
  lines.push(
    ["уровень", "договор", "подрядчик", "работа", "название", "статус", "цена", "выплачено", "остаток"]
      .map(esc)
      .join(",")
  );
  for (const r of reports) {
    for (const w of r.works) {
      lines.push(
        [
          "работа",
          r.contract.contract_id,
          r.contract.contractor,
          w.work_id,
          w.title,
          STATUS_RU[w.statusAsOf],
          money(w.price),
          money(w.paid),
          w.statusAsOf === "cancelled" ? "" : money(w.remaining),
        ]
          .map((x) => esc(String(x)))
          .join(",")
      );
    }
    lines.push(
      [
        "договор",
        r.contract.contract_id,
        r.contract.contractor,
        "",
        "ИТОГО",
        "",
        money(r.billable),
        money(r.paidNet),
        money(r.remaining),
      ]
        .map((x) => esc(String(x)))
        .join(",")
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const asOf = arg("date") ?? "2026-11-10";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    console.error(`Неверная дата: ${asOf}. Ожидается YYYY-MM-DD.`);
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = join(here, "..", "data");
  const read = (f: string) => readFileSync(join(dataDir, f), "utf8");

  const contracts: Contract[] = parseCsv(read("contracts.csv")).map((r) => ({
    contract_id: r.contract_id,
    contractor: r.contractor,
    amount: parseMoney(r.amount),
    signed_at: r.signed_at,
  }));

  const works: Work[] = parseCsv(read("works.csv")).map((r) => ({
    work_id: r.work_id,
    contract_id: r.contract_id,
    title: r.title,
    price: parseMoney(r.price),
    rawStatus: r.status,
    completed_at: r.completed_at,
    cancelled_at: r.cancelled_at,
    statusAsOf: "planned",
    directPaid: 0n,
    allocated: 0n,
    paid: 0n,
    remaining: 0n,
  }));

  const payments: Payment[] = parseCsv(read("payments.csv")).map((r) => ({
    payment_id: r.payment_id,
    contract_id: r.contract_id,
    work_id: r.work_id,
    purpose: r.purpose,
    amount: parseMoney(r.amount),
    status: r.status,
    created_at: r.created_at,
    paid_at: r.paid_at,
    refunded_at: r.refunded_at,
  }));

  const reports = build(contracts, works, payments, asOf);

  console.log(renderText(reports, asOf));

  const csvPath = arg("csv");
  if (csvPath) {
    writeFileSync(csvPath, renderCsv(reports, asOf), "utf8");
    console.log(`\nCSV сохранён: ${csvPath}`);
  }
}

main();
