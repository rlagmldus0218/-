"use strict";
const $ = (id) => document.getElementById(id);
const fmt = (v, d = 0) => Number(v).toLocaleString("ko-KR", { maximumFractionDigits: d });
const pct = (x, y) => (y ? fmt((x / y) * 100, 1) : "-");
const cache = new Map();
let META = null, SUM = [];
const basket = [];

function opt(sel, items, keep) {
  const old = sel.value;
  sel.replaceChildren(...items.map(([v, t]) => Object.assign(document.createElement("option"), { value: v, textContent: t })));
  if (keep && items.some(([v]) => v === old)) sel.value = old;
}
function rowsOf(tbody, rows) {
  tbody.replaceChildren(...rows.map((r) => {
    const tr = document.createElement("tr");
    r.forEach((c, i) => { const td = document.createElement("td"); td.textContent = c; if (typeof c === "string" && /^[-\d,.]+$/.test(c) && i > 0 && !/^\d{4}$/.test(c)) td.className = "num"; tr.append(td); });
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

/* ---------- 콤보박스(자동완성 목록) ---------- */
function combo(input, list, getItems, onPick) {
  let items = [], act = -1;
  const draw = () => {
    list.replaceChildren(...items.map((it, i) => {
      const li = document.createElement("li"); li.setAttribute("role", "option"); if (i === act) li.className = "act";
      const a = document.createElement("span"), b = document.createElement("small"); a.textContent = it.name; b.textContent = it.sub; li.append(a, b);
      li.onmousedown = (e) => { e.preventDefault(); pick(i); }; return li; }));
    list.hidden = !items.length; input.setAttribute("aria-expanded", String(!list.hidden));
  };
  const open = () => { const q = input.value.trim().toLowerCase(); items = getItems(q).slice(0, 15); act = -1; draw(); };
  const pick = (i) => { const it = items[i]; if (!it) return; input.value = it.name; list.hidden = true; onPick(it); };
  input.addEventListener("input", open); input.addEventListener("focus", open); input.addEventListener("blur", () => (list.hidden = true));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (list.hidden) open(); act = (act + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; draw(); }
    else if (e.key === "Enter" && !list.hidden) { e.preventDefault(); pick(act < 0 ? 0 : act); }
    else if (e.key === "Escape") list.hidden = true;
  });
}
const rank = (q, c, n) => { const a = n.toLowerCase(), b = c.toLowerCase(); return a === q ? 0 : a.startsWith(q) ? 1 : a.includes(q) ? 2 : b.startsWith(q) ? 3 : b.includes(q) ? 4 : 9; };
function search(entries, q) { // entries: [{level, code, name, sub}]
  if (!q) return entries;
  return entries.map((e) => [rank(q, e.code, e.name), e]).filter(([r]) => r < 9).sort((x, y) => x[0] - y[0]).map(([, e]) => e);
}
function mkTable(head, rows, cap) {
  const d = document.createElement("div"); d.className = "scroll"; const t = document.createElement("table");
  if (cap) { const c = document.createElement("caption"); c.textContent = cap; t.append(c); }
  const th = document.createElement("thead"), tr = document.createElement("tr");
  head.forEach((h) => { const x = document.createElement("th"); x.textContent = h; tr.append(x); }); th.append(tr); t.append(th);
  const tb = document.createElement("tbody"); rowsOf(tb, rows); t.append(tb); d.append(t); return d;
}
const entriesOf = (k) => META.levels[k].sectors.map(([c, n]) => ({ level: k, code: c, name: n, sub: `${META.levels[k].label} · ${c}` }));


/* ---------- 불러오기 ---------- */
$("load").onclick = async () => {
  $("status").textContent = "불러오는 중...";
  try {
    META = await (await fetch("./data/meta.json")).json();
    const lv = Object.entries(META.levels).map(([k, v]) => [k, `${v.label} (${v.sectors.length}개)`]);
    ["e-level", "s-level", "m-level", "d-level"].forEach((id) => { opt($(id), lv); $(id).value = "L"; $(id).disabled = false; });
    opt($("e-sheet"), META.sheets.map((s, i) => [i, `${i + 1}. ${s}`]));
    ["e-sheet", "e-rq", "e-cq", "e-row", "f-q", "m-q", "m-amt", "m-add", "s-run", "d-q", "d-metric", "d-item", "c-q", "c-amt", "c-run"].forEach((id) => ($(id).disabled = false));
    $("status").textContent = "불러오기 완료. 4개 분류의 메타 정보를 읽었습니다. 시트 값은 선택할 때 불러옵니다.";
    SUM = await fetch("./data/summary.json").then((r) => r.json());
    opt($("d-item"), FD_ITEMS); $("d-item").value = "9140";
    await loadExplorer(); drawDemand();
    const rep = await fetch("./validation-report.json").then((r) => r.json()).catch(() => null);
    $("validation").textContent = rep ? JSON.stringify(rep, null, 1) : "검증 파일 없음";
  } catch (e) { $("status").textContent = "오류: " + e.message; }
};

/* ---------- 1. 부문 찾기 + 산업 정보 ---------- */
const statCache = new Map();
const cellFn = (sh) => { const ci = new Map(sh.cols.map(([c], i) => [c, i])), rr = new Map(sh.rows.map((r) => [r[0], r[2]])); return (r, c) => rr.get(r)[ci.get(c)]; };
async function stats(level) {
  if (statCache.has(level)) return statCache.get(level);
  const codes = META.levels[level].sectors.map((x) => x[0]), n = codes.length;
  const [T, Lm, Im, Vm] = (await Promise.all([1, 7, 8, 9].map((i) => getSheet(level, i - 1)))).map(cellFn);
  const cs = codes.map((c) => codes.reduce((a, r) => a + Lm(r, c), 0)), rs = codes.map((r) => codes.reduce((a, c) => a + Lm(r, c), 0));
  const mc = cs.reduce((a, b) => a + b) / n, mr = rs.reduce((a, b) => a + b) / n;
  const st = { codes, out: codes.map((c) => T("9790", c)), va: codes.map((c) => T("9690", c)), mid: codes.map((c) => T("9590", c)),
    exp: codes.map((c) => T(c, "9140")), imp: codes.map((c) => T(c, "9329")), sup: codes.map((c) => T(c, "9390")),
    prod: cs, bl: cs.map((v) => v / mc), fl: rs.map((v) => v / mr),
    vac: codes.map((c) => codes.reduce((a, r) => a + Vm(r, c), 0)), imc: codes.map((c) => codes.reduce((a, r) => a + Im(r, c), 0)) };
  statCache.set(level, st); return st;
}
const colIdx = (sh, yr, key) => sh.cols.findIndex(([n]) => n.includes(yr + "년") && !n.includes("구성비") && !n.includes("차이") && (!key || n.includes(key)));
const sumSheet = (no) => SUM.find((x) => x.no === no);
function empRows(Lcode) {
  const defs = [[16, "취업자수", "취업자수", "천명(전업환산)", 1], [17, "임금근로자수", "임금근로자수", "천명(전업환산)", 1], [18, "취업계수", "취업계수", "명/총산출 10억원", 2],
    [18, "고용계수", "고용계수", "명/총산출 10억원", 2], [19, "취업유발계수", "", "명/최종수요 10억원", 2], [20, "고용유발계수", "", "명/최종수요 10억원", 2]];
  return defs.map(([no, label, key, unit, d]) => { const sh = sumSheet(no), row = sh.rows[Lcode], all = sh.rows.ALL;
    const f = (r, yr) => { const v = r[colIdx(sh, yr, key)]; return v == null ? "-" : fmt(v, d); };
    return [label, ...["2020", "2021", "2022", "2023"].map((y) => f(row, y)), f(all, "2023"), unit]; });
}
async function showInfo(it) {
  const box = $("f-info"); box.hidden = false; box.textContent = "불러오는 중...";
  const st = await stats(it.level), i = st.codes.indexOf(it.code), lv = META.levels[it.level].label, Lc = META.parent[it.level][it.code];
  const Ln = META.levels.L.sectors.find((x) => x[0] === Lc)[1], o = st.out[i], pct = (a, b) => (b ? fmt((a / b) * 100, 1) : "-");
  const chain = it.level === "B" && META.mapping[it.code] ? META.mapping[it.code].map((x) => x[1]).join(" › ") : "";
  const head = document.createElement("div"); head.className = "info";
  head.innerHTML = "<h3></h3><p class='note'></p>"; head.firstChild.textContent = `${it.name}`;
  head.lastChild.textContent = `${lv} · 코드 ${it.code}` + (chain ? ` · 소분류›중분류›대분류: ${chain}` : it.level !== "L" ? ` · 소속 대분류: ${Ln}` : "");
  const base = [["총산출", fmt(o), "백만원"], ["부가가치", fmt(st.va[i]), "백만원"], ["부가가치율", pct(st.va[i], o), "% (부가가치÷총산출)"], ["중간투입률", pct(st.mid[i], o), "% (중간투입÷총산출)"],
    ["수출액", fmt(st.exp[i]), "백만원"], ["수출률", pct(st.exp[i], o), "% (수출÷총산출)"], ["수입액(수입계)", fmt(st.imp[i]), "백만원"], ["수입률", pct(st.imp[i], st.sup[i]), "% (수입÷총공급)"],
    ["생산유발계수", fmt(st.prod[i], 3), "무차원: 최종수요 1단위당 총산출 유발"], ["부가가치유발계수", fmt(st.vac[i], 3), "무차원"], ["수입유발계수", fmt(st.imc[i], 3), "무차원"],
    ["영향력계수", fmt(st.bl[i], 3), "무차원 지수(평균=1)"], ["감응도계수", fmt(st.fl[i], 3), "무차원 지수(평균=1)"]];
  const e = document.createElement("p"); e.className = "note";
  e.textContent = it.level === "L" ? "취업·고용 통계는 연장표(통합대분류 33부문, 2020~2023) 값입니다." : `취업·고용 통계는 연장표가 통합대분류 기준이라, 이 부문이 속한 대분류 「${Ln}」의 값을 보여줍니다.`;
  box.replaceChildren(head, mkTable(["지표", "값", "단위"], base, `구조 지표 · 2023년 · ${lv} 기준`), mkTable(["지표", "2020", "2021", "2022", "2023", "전산업 2023", "단위"], empRows(Lc), `취업·고용 · 대분류 「${Ln}」 기준`), e);
}
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
let simPick = null;
const resetPick = () => { simPick = null; $("m-q").value = ""; };
function drawBasket() {
  $("m-basket").replaceChildren(...basket.map((b, i) => { const li = document.createElement("li");
    li.textContent = `${b.code} ${b.name}: +${fmt(b.amt, 2)}백만원 `; const x = document.createElement("button"); x.type = "button"; x.textContent = "삭제";
    x.onclick = () => { basket.splice(i, 1); drawBasket(); }; li.append(x); return li; }));
  $("m-run").disabled = !basket.length;
  $("m-status").textContent = basket.length ? `${basket.length}개 항목 · 합계 ${fmt(basket.reduce((s, b) => s + b.amt, 0), 2)}백만원` : "시나리오를 추가하세요.";
}
$("m-form").onsubmit = (e) => {
  e.preventDefault(); const amt = +$("m-amt").value;
  if (!simPick) { $("m-status").textContent = "산업 검색창에 입력한 뒤 목록에서 산업을 선택하세요."; return; }
  if (!(amt > 0)) return;
  const { code, name } = simPick, f = basket.find((b) => b.code === code);
  f ? (f.amt += amt) : basket.push({ code, name, amt }); drawBasket(); resetPick();
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
  const lvl = $("m-level").value, par = META.parent[lvl], coef = (no) => { const sh = sumSheet(no), k = colIdx(sh, "2023", ""); return (c) => sh.rows[par[c]][k]; };
  const jb = coef(19), gy = coef(20), emp = basket.reduce((a, b) => a + (b.amt / 1000) * jb(b.code), 0), wag = basket.reduce((a, b) => a + (b.amt / 1000) * gy(b.code), 0);
  const card = (t, v, u) => `<div class="card"><small>${t}</small><b>${v}</b><em>${u}</em></div>`;
  $("m-cards").innerHTML = card("최종수요 증가액", fmt(dem, 1), "백만원") + card("총 생산유발액", fmt(S(2), 1), "백만원") + card("생산유발승수", fmt(S(2) / dem, 3), "배(무차원)")
    + card("부가가치유발액", fmt(S(4), 1), "백만원") + card("수입유발액(중간재)", fmt(S(3), 1), "백만원") + card("취업유발 인원(추정)", fmt(emp, 1), "명 (전업환산)") + card("고용유발 인원(추정)", fmt(wag, 1), "명 (임금근로자)");
  $("m-note").textContent = "취업·고용유발은 연장표 2023년 대분류 취업·고용유발계수(명/최종수요 10억원)를 증가액에 곱해 추정했습니다(중·소·기본부문은 상위 대분류 계수 적용).";
  barList($("m-bars"), lastRows.slice(0, 15).map((r) => [r[1], r[2]]), "", 1);
  rowsOf($("m-rows"), lastRows.slice(0, 100).map((r) => [r[0], r[1], fmt(r[2], 1), fmt(r[3], 1), fmt(r[4], 1)]));
  $("m-res").hidden = false;
};
$("m-csv").onclick = () => {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const t = "코드,산업,생산유발액(백만원),수입유발액(백만원),부가가치유발액(백만원)\n" + lastRows.map((r) => [r[0], q(r[1]), r[2], r[3], r[4]].join(",")).join("\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob(["\ufeff" + t], { type: "text/csv" })), download: "시뮬레이션결과.csv" }); a.click();
};

/* ---------- 콤보박스 연결 ---------- */
combo($("f-q"), $("f-list"), (q) => search(["L", "M", "S", "B"].flatMap(entriesOf), q), showInfo);
combo($("m-q"), $("m-list"), (q) => (META ? search(entriesOf($("m-level").value), q) : []), (it) => (simPick = it));
$("m-q").addEventListener("input", () => (simPick = null));
$("m-level").onchange = () => { basket.length = 0; drawBasket(); $("m-res").hidden = true; resetPick(); };

/* ---------- 최종수요 항목별 분석 (시트 10~12) ---------- */
const FD_ITEMS = [["9111", "민간소비지출"], ["9112", "정부소비지출"], ["9121", "민간고정자본형성"], ["9122", "정부고정자본형성"], ["9131", "재고증감"], ["9132", "귀중품 순취득"], ["9140", "수출"], ["9190", "최종수요계"]];
const FD_NAMES = ["생산", "수입", "부가가치"];
const fdSheets = (level) => Promise.all([9, 10, 11].map((i) => getSheet(level, i).then(cellFn)));
let dPick = null;
async function drawDemand() {
  if (!META) return;
  const lv = $("d-level").value, lab = META.levels[lv].label, F = await fdSheets(lv);
  const head = ["최종수요 항목"], rows = FD_ITEMS.map(([, n]) => [n]);
  F.forEach((f, k) => { head.push(`${FD_NAMES[k]} 유발액(백만원)`, `${FD_NAMES[k]} 구성비(%)`, `${FD_NAMES[k]} 유발계수`);
    FD_ITEMS.forEach(([c], r) => rows[r].push(fmt(f("9819", c)), fmt(f("9812", c), 1), fmt(f("9811", c), 3))); });
  $("d-sum").replaceChildren(mkTable(head, rows, `최종수요 항목별 유발 효과 · ${lab} 기준 · 2023년`));
  dPick = null; $("d-q").value = ""; $("d-dep").replaceChildren(); drawTop();
}
async function drawDep() {
  if (!dPick) return;
  const lv = $("d-level").value, F = await fdSheets(lv), c = dPick.code, tot = F.map((f) => f(c, "9190"));
  const rows = FD_ITEMS.map(([k, n]) => [n, fmt(F[0](c, k)), k === "9190" ? "100.0" : pct(F[0](c, k), tot[0]), fmt(F[1](c, k)), fmt(F[2](c, k))]);
  $("d-dep").replaceChildren(mkTable(["최종수요 항목", "생산유발액(백만원)", "생산 의존도(%)", "수입유발액(백만원)", "부가가치유발액(백만원)"], rows, `「${dPick.name}」은(는) 어떤 최종수요로 유발되는가 · ${META.levels[lv].label}`));
}
async function drawTop() {
  if (!META) return;
  const lv = $("d-level").value, k = +$("d-metric").value, c = $("d-item").value, f = (await fdSheets(lv))[k];
  const top = META.levels[lv].sectors.map(([code, n]) => [n, f(code, c)]).sort((x, y) => y[1] - x[1]).slice(0, 15);
  $("d-topcap").textContent = `${FD_NAMES[k]}유발액 상위 15개 산업 · ${FD_ITEMS.find((x) => x[0] === c)[1]} · 단위: 백만원 (전체 ${fmt(f("9819", c))}백만원)`;
  barList($("d-top"), top, "", 0);
}
$("d-level").onchange = drawDemand; $("d-metric").onchange = drawTop; $("d-item").onchange = drawTop;
combo($("d-q"), $("d-list"), (q) => (META ? search(entriesOf($("d-level").value), q) : []), (it) => { dPick = it; drawDep(); });
$("d-q").addEventListener("input", () => (dPick = null));

/* ---------- 분류 수준 비교 ---------- */
let cPick = null;
combo($("c-q"), $("c-list"), (q) => (META ? search(entriesOf("B"), q) : []), (it) => (cPick = it));
$("c-q").addEventListener("input", () => (cPick = null));
$("c-run").onclick = async () => {
  const amt = +$("c-amt").value;
  if (!cPick) { $("c-status").textContent = "기본부문을 검색해 목록에서 선택하세요."; return; }
  if (!(amt > 0)) { $("c-status").textContent = "증가액은 0보다 커야 합니다."; return; }
  $("c-status").textContent = "계산 중...";
  const mp = META.mapping[cPick.code], anc = { L: mp[2], M: mp[1], S: mp[0], B: [cPick.code, cPick.name] }, rows = [];
  for (const lv of ["L", "M", "S", "B"]) {
    const m = await model(lv), n = m.codes.length, i = m.codes.indexOf(anc[lv][0]);
    const x = m.L.map((r) => r[i] * amt);                                       // x = L·Δf (Δf: i번째 부문만 amt)
    const am = m.codes.map((_, j) => m.Am.reduce((s, r) => s + r[j], 0));        // 수입투입계수 열합
    const X = x.reduce((s, v) => s + v, 0), VA = x.reduce((s, v, j) => s + v * m.va[j], 0), IM = x.reduce((s, v, j) => s + v * am[j], 0);
    rows.push([META.levels[lv].label + ` (${n}개)`, `${anc[lv][0]} ${anc[lv][1]}`, fmt(X, 1), fmt(X / amt, 3), fmt(VA, 1), fmt(IM, 1)]);
  }
  $("c-status").textContent = `「${cPick.name}」(기본부문 ${cPick.code})에 ${fmt(amt, 2)}백만원 · 상위 부문: ${anc.S[1]} › ${anc.M[1]} › ${anc.L[1]}`;
  $("c-res").replaceChildren(mkTable(["분류", "수요가 투입되는 부문", "생산유발액(백만원)", "생산유발승수(배)", "부가가치유발액(백만원)", "수입유발액(백만원)"], rows, "같은 금액, 분류별 결과 비교"),
    Object.assign(document.createElement("p"), { className: "note", textContent: "분류가 거칠수록 수요가 묶음 전체의 평균 구조에 투입되는 것으로 가정되어 결과가 달라질 수 있습니다. 취업·고용유발은 연장표가 대분류 기준이라 분류 간 차이가 없어 제외했습니다." }));
};

/* ---------- 탭 ---------- */
function showTab() {
  const id = ["finder", "explorer", "structure", "demand", "simulation", "compare", "about"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "finder";
  document.querySelectorAll("section.tab").forEach((s) => s.classList.toggle("on", s.id === id));
  document.querySelectorAll("nav a").forEach((l) => { const on = l.getAttribute("href") === "#" + id; l.classList.toggle("on", on); l.setAttribute("aria-selected", String(on)); });
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", showTab); showTab();
