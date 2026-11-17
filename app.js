"use strict";
const $ = (id) => document.getElementById(id);
const fmt = (v, d = 0) => Number(v).toLocaleString("ko-KR", { maximumFractionDigits: d });
const cache = new Map();
let META = null;
const basket = [];

function opt(sel, items, keep) {
  const old = sel.value;
  sel.replaceChildren(...items.map(([v, t]) => Object.assign(document.createElement("option"), { value: v, textContent: t })));
  if (keep && items.some(([v]) => v === old)) sel.value = old;
}
function rowsOf(tbody, rows) {
  tbody.replaceChildren(...rows.map((r) => {
    const tr = document.createElement("tr");
    r.forEach((c, i) => { const td = document.createElement("td"); td.textContent = c; if (typeof c === "string" && /^[-\d,.]+$/.test(c) && i > 1) td.className = "num"; tr.append(td); });
    return tr;
  }));
}
async function getSheet(level, idx) {
  const k = level + idx;
  if (!cache.has(k)) {
    const r = await fetch(`./data/${level}/s${String(idx + 1).padStart(2, "0")}.json`);
    if (!r.ok) throw new Error("자료 파일을 읽지 못했습니다: " + k);
    cache.set(k, await r.json());
  }
  return cache.get(k);
}
const SHEET_IDX = { T: 0, Am: 4, A: 3, L: 6 };

/* ---------- 불러오기 ---------- */
$("load").onclick = async () => {
  $("status").textContent = "불러오는 중...";
  try {
    META = await (await fetch("./data/meta.json")).json();
    const lv = Object.entries(META.levels).map(([k, v]) => [k, `${v.label} (${v.sectors.length}개)`]);
    ["e-level", "s-level", "m-level"].forEach((id) => { opt($(id), lv); $(id).value = "L"; $(id).disabled = false; });
    opt($("e-sheet"), META.sheets.map((s, i) => [i, `${i + 1}. ${s}`]));
    ["e-sheet", "e-rq", "e-cq", "e-row", "f-q", "m-q", "m-sec", "m-amt", "m-add", "s-run"].forEach((id) => ($(id).disabled = false));
    $("status").textContent = "불러오기 완료. 4개 분류의 메타 정보를 읽었습니다. 시트 값은 선택할 때 불러옵니다.";
    fillSectors(); drawFinder(); await loadExplorer();
    const rep = await fetch("./validation-report.json").then((r) => r.json()).catch(() => null);
    $("validation").textContent = rep ? JSON.stringify(rep, null, 1) : "검증 파일 없음";
  } catch (e) { $("status").textContent = "오류: " + e.message; }
};

/* ---------- 1. 부문 찾기 ---------- */
function drawFinder() {
  const q = $("f-q").value.trim().toLowerCase(), out = [];
  for (const [k, v] of Object.entries(META.levels)) for (const [c, n] of v.sectors) {
    if (q && !(c.toLowerCase().includes(q) || n.toLowerCase().includes(q))) continue;
    const p = k === "B" && META.mapping[c] ? META.mapping[c].map((x) => x[1]).join(" › ") : "";
    out.push([v.label, c, n, p]);
  }
  rowsOf($("f-rows"), out.slice(0, 100));
}
$("f-q").oninput = drawFinder;

/* ---------- 2. 원자료 탐색 ---------- */
let curSheet = null;
const unitOf = (rowName, sh) => /구성비|비중/.test(rowName) ? "% (구성비)" : /계수|열합|행합/.test(rowName) ? "무차원 계수(비율)" : sh.unit === "백만원" ? "백만원 (2023년 당해가격, 생산자가격)" : sh.unit;
async function loadExplorer() {
  curSheet = await getSheet($("e-level").value, +$("e-sheet").value);
  const q = $("e-rq").value.trim().toLowerCase();
  const rows = curSheet.rows.map((r, i) => [i, `${r[0]} ${r[1]}`]).filter(([, t]) => t.toLowerCase().includes(q));
  opt($("e-row"), rows.length ? rows : [["", "(검색 결과 없음)"]], true);
  drawCells();
}
function drawCells() {
  const r = curSheet.rows[$("e-row").value]; if (!r) return rowsOf($("e-cells"), []);
  const q = $("e-cq").value.trim().toLowerCase();
  const out = curSheet.cols.map(([c, n], i) => [c, n, r[2][i]]).filter(([c, n]) => (c + n).toLowerCase().includes(q))
    .map(([c, n, v]) => [c, n, Number.isInteger(v) ? fmt(v) : fmt(v, 6)]);
  $("e-cap").textContent = `${$("e-level").selectedOptions[0].text} · ${META.sheets[$("e-sheet").value]} · 행: ${r[0]} ${r[1]}`;
  $("e-unit").textContent = `단위: ${unitOf(r[1], curSheet)}`;
  rowsOf($("e-cells"), out);
}
["e-level", "e-sheet"].forEach((id) => ($(id).onchange = loadExplorer));
$("e-rq").oninput = loadExplorer; $("e-row").onchange = drawCells; $("e-cq").oninput = drawCells;

/* ---------- 공통: 행렬 준비 ---------- */
async function model(level) {
  const sec = META.levels[level].sectors, codes = sec.map((s) => s[0]);
  const [L, Am, A] = await Promise.all([getSheet(level, 6), getSheet(level, 4), getSheet(level, 3)]);
  const get = (sh, rc) => { const ci = new Map(sh.cols.map(([c], i) => [c, i])), rr = new Map(sh.rows.map((r) => [r[0], r[2]]));
    return rc.map((r) => codes.map((c) => rr.get(r)[ci.get(c)])); };
  const va = get(A, ["9690"])[0];
  return { sec, codes, L: get(L, codes), Am: get(Am, codes), va };
}

/* ---------- 3. 구조 분석 ---------- */
function barList(el, items, unit, d = 3) {
  const max = Math.max(...items.map((x) => x[1]));
  el.replaceChildren(...items.map(([n, v]) => { const d1 = document.createElement("div"); d1.className = "bar";
    d1.innerHTML = `<span></span><i style="width:${(v / max) * 100}%"></i><b>${fmt(v, d)}${unit}</b>`; d1.firstChild.textContent = n; return d1; }));
}
$("s-run").onclick = async () => {
  const m = await model($("s-level").value), n = m.codes.length;
  const col = m.codes.map((_, j) => m.L.reduce((s, r) => s + r[j], 0)), row = m.L.map((r) => r.reduce((s, v) => s + v, 0));
  const mc = col.reduce((a, b) => a + b, 0) / n, mr = row.reduce((a, b) => a + b, 0) / n;
  const bl = col.map((v) => v / mc), fl = row.map((v) => v / mr);
  const top = (a) => a.map((v, i) => [m.sec[i][1], v]).sort((x, y) => y[1] - x[1]).slice(0, 15);
  barList($("s-bl"), top(bl), ""); barList($("s-fl"), top(fl), "");
  const key = m.sec.filter((_, i) => bl[i] > 1 && fl[i] > 1).map((s) => s[1]);
  $("s-key").textContent = `영향력·감응도계수가 모두 1보다 큰 핵심 부문 ${key.length}개: ${key.slice(0, 20).join(", ")}${key.length > 20 ? " 외" : ""}`;
};

/* ---------- 4. 시뮬레이션 ---------- */
function fillSectors() {
  if (!META) return;
  const q = $("m-q").value.trim().toLowerCase();
  const items = META.levels[$("m-level").value].sectors.filter(([c, n]) => (c + n).toLowerCase().includes(q)).map(([c, n]) => [c, `${c} ${n}`]);
  opt($("m-sec"), items.length ? items : [["", "(검색 결과 없음)"]], true);
}
$("m-level").onchange = () => { basket.length = 0; drawBasket(); $("m-res").hidden = true; fillSectors(); };
$("m-q").oninput = fillSectors;
function drawBasket() {
  $("m-basket").replaceChildren(...basket.map((b, i) => { const li = document.createElement("li");
    li.textContent = `${b.code} ${b.name}: +${fmt(b.amt, 2)}백만원 `; const x = document.createElement("button"); x.type = "button"; x.textContent = "삭제";
    x.onclick = () => { basket.splice(i, 1); drawBasket(); }; li.append(x); return li; }));
  $("m-run").disabled = !basket.length;
  $("m-status").textContent = basket.length ? `${basket.length}개 항목 · 합계 ${fmt(basket.reduce((s, b) => s + b.amt, 0), 2)}백만원` : "시나리오를 추가하세요.";
}
$("m-form").onsubmit = (e) => {
  e.preventDefault(); const code = $("m-sec").value, amt = +$("m-amt").value;
  if (!code || !(amt > 0)) return;
  const f = basket.find((b) => b.code === code), name = META.levels[$("m-level").value].sectors.find((s) => s[0] === code)[1];
  f ? (f.amt += amt) : basket.push({ code, name, amt }); drawBasket();
};
$("m-clear").onclick = () => { basket.length = 0; drawBasket(); $("m-res").hidden = true; };
let lastRows = [];
$("m-run").onclick = async () => {
  const m = await model($("m-level").value), n = m.codes.length, f = new Array(n).fill(0);
  basket.forEach((b) => (f[m.codes.indexOf(b.code)] += b.amt));
  const x = m.L.map((r) => r.reduce((s, v, j) => s + v * f[j], 0));        // 생산유발액 = L·Δf
  const imp = m.Am.map((r) => r.reduce((s, v, j) => s + v * x[j], 0));     // 수입(중간재) = Am·x
  const vad = x.map((v, j) => v * m.va[j]);                                // 부가가치 = 부가가치율×x
  lastRows = m.sec.map(([c, nm], i) => [c, nm, x[i], imp[i], vad[i]]).sort((a, b) => b[2] - a[2]);
  const S = (k) => lastRows.reduce((s, r) => s + r[k], 0), dem = f.reduce((a, b) => a + b, 0);
  const card = (t, v, u) => `<div class="card"><small>${t}</small><b>${v}</b><em>${u}</em></div>`;
  $("m-cards").innerHTML = card("최종수요 증가액", fmt(dem, 1), "백만원") + card("총 생산유발액", fmt(S(2), 1), "백만원") + card("생산유발승수", fmt(S(2) / dem, 3), "배(무차원)")
    + card("부가가치유발액", fmt(S(4), 1), "백만원") + card("수입유발액(중간재)", fmt(S(3), 1), "백만원");
  barList($("m-bars"), lastRows.slice(0, 15).map((r) => [r[1], r[2]]), "", 1);
  rowsOf($("m-rows"), lastRows.slice(0, 100).map((r) => [r[0], r[1], fmt(r[2], 1), fmt(r[3], 1), fmt(r[4], 1)]));
  $("m-res").hidden = false;
};
$("m-csv").onclick = () => {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const t = "코드,산업,생산유발액(백만원),수입유발액(백만원),부가가치유발액(백만원)\n" + lastRows.map((r) => [r[0], q(r[1]), r[2], r[3], r[4]].join(",")).join("\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob(["\ufeff" + t], { type: "text/csv" })), download: "시뮬레이션결과.csv" }); a.click();
};
