"""엑셀 원자료 -> 웹앱용 JSON 변환 + 계수 검증 (한 번만 실행하면 됩니다)
사용법: 엑셀 파일 6개를 raw/ 폴더에 넣고  python model.py
출처: 한국은행 「2023년 산업연관표(연장표)」 (공공데이터, 개인정보 없음)
"""
import json, os, re
import numpy as np
import openpyxl

RAW, OUT = "raw", "data"
LEVELS = {  # 코드: (표시명, 파일명 일부)
    "L": ("통합대분류", "통합대분류"), "M": ("통합중분류", "통합중분류"),
    "S": ("통합소분류", "통합소분류"), "B": ("기본부문", "기본부문")}
SHEETS = ["A표_총거래표(생산자)", "A표_수입거래표(생산자)", "A표_국산거래표(생산자)",
          "총투입계수(A)", "수입투입계수(Am)", "국산투입계수(Ad)", "생산유발계수",
          "수입유발계수", "부가가치유발계수", "최종수요 항목별 생산유발액",
          "최종수요 항목별 수입유발액", "최종수요 항목별 부가가치유발액"]


def num(v):
    if isinstance(v, (int, float)):
        return int(v) if float(v).is_integer() else float(f"{v:.6g}")
    return 0


def clean(s):
    return re.sub(r"\s+", " ", str(s).replace("\n", " ")).strip() if s is not None else ""


def read_sheet(ws):
    rows = list(ws.iter_rows(values_only=True))
    unit = next((clean(r[0]).replace("단위 :", "").strip() for r in rows[:5]
                 if r[0] and "단위" in str(r[0])), "무차원 계수(비율)")
    codes, names = rows[4], rows[5]
    cols = [(clean(codes[i]), clean(names[i])) for i in range(2, len(codes))
            if codes[i] is not None or names[i] is not None]
    data = [[clean(r[0]), clean(r[1]), [num(x) for x in r[2:2 + len(cols)]]]
            for r in rows[6:] if r[0] is not None or r[1] is not None]
    return {"unit": unit, "cols": cols, "rows": data}


def mat(sh, rcodes, ccodes):
    ci = {c: k for k, (c, _) in enumerate(sh["cols"])}
    rr = {r[0]: r[2] for r in sh["rows"]}
    return np.array([[rr[r][ci[c]] for c in ccodes] for r in rcodes], float)


ALIAS = {"C14": "제조임가공산업용장비수리", "D": "전력가스증기"}  # 연장표와 부문명이 다른 대분류
SUM_UNIT = {1: "조원", 2: "조원", 3: "%", 4: "%", 5: "%", 6: "%", 9: "%", 10: "%", 11: "무차원", 12: "무차원",
            13: "무차원", 14: "무차원", 16: "천명", 17: "천명", 18: "명/10억원", 19: "명/10억원", 20: "명/10억원"}


def nm(s):
    return re.sub(r"[^0-9A-Za-z가-힣]", "", re.sub(r"\d\)$", "", re.sub(r"\s+", "", str(s))))


def parse_summary(ws):
    """연장표 시트: 머리글(행 5~)과 부문 행을 자동 인식 (부문명 들여쓰기 1~3열)"""
    r = list(ws.iter_rows(values_only=True))
    isn = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)

    def lab(x):
        for k in (1, 2, 3):
            if k < len(x) and isinstance(x[k], str) and x[k].strip() and not x[k].strip().startswith(("주", "(")):
                return x[k]
    r0 = next(i for i, x in enumerate(r) if i > 4 and lab(x) and any(isn(v) for v in x))
    ncol, hdr = max(len(x) for x in r), []
    for x in r[4:r0]:
        cur, row = None, []
        for c in range(ncol):
            v = x[c] if c < len(x) else None
            if v == "": cur = None
            elif v is not None and str(v).strip(): cur = re.sub(r"\s+", " ", str(v)).strip()
            row.append(cur)
        hdr.append(row)
    cols = [c for c in range(ncol) if any(isn(x[c]) for x in r[r0:] if c < len(x))]
    names = [" ".join(dict.fromkeys(h[c] for h in hdr if h[c])) for c in cols]
    rows = {nm(lab(x)): [num(x[c]) if c < len(x) and isn(x[c]) else None for c in cols]
            for x in r[r0:] if lab(x) and any(c < len(x) and isn(x[c]) for c in cols)}
    return names, rows


def col_unit(no, name):
    if "구성비 차이" in name or (no in (3, 4, 5, 6) and "차이" in name): return "%p"
    return "%" if "구성비" in name else SUM_UNIT.get(no, "")


def main():
    os.makedirs(OUT, exist_ok=True)
    meta, report = {"levels": {}, "sheets": SHEETS}, {}
    # 상품분류(기본->소->중->대) 매핑
    ws = openpyxl.load_workbook(f"{RAW}/_표_상품분류.xlsx", read_only=True, data_only=True).worksheets[0]
    mp, cur = {}, [None] * 4
    for r in list(ws.iter_rows(values_only=True))[3:]:
        for k in (3, 2, 1, 0):  # 상위 분류가 바뀌면 하위도 새로 갱신
            if r[2 * k]:
                cur[k] = (clean(r[2 * k]), clean(r[2 * k + 1]))
        if r[0] and not str(r[0]).startswith("98"):
            mp[clean(r[0])] = [cur[1], cur[2], cur[3]]
    for key, (label, part) in LEVELS.items():
        f = [x for x in os.listdir(RAW) if part in x and "투입산출표" in x][0]
        wb = openpyxl.load_workbook(f"{RAW}/{f}", read_only=True, data_only=True)
        os.makedirs(f"{OUT}/{key}", exist_ok=True)
        S = {}
        for i, name in enumerate(SHEETS):
            S[name] = read_sheet(wb[name])
            json.dump(S[name], open(f"{OUT}/{key}/s{i + 1:02d}.json", "w", encoding="utf-8"),
                      ensure_ascii=False, separators=(",", ":"))
        T = S[SHEETS[0]]
        sec = [(r[0], r[1]) for r in T["rows"] if not r[0].startswith("9")]
        codes = [c for c, _ in sec]
        # 검증: (I-Ad)^-1 이 원표의 생산유발계수와 같은지
        Ad = mat(S["국산투입계수(Ad)"], codes, codes)
        L = mat(S["생산유발계수"], codes, codes)
        err = float(np.abs(np.linalg.inv(np.eye(len(codes)) - Ad) - L).max())
        out = mat(S["A표_총거래표(생산자)"], ["9790"], codes)[0]
        va = mat(S["총투입계수(A)"], ["9690"], codes)[0]
        report[label] = {"부문수": len(codes), "생산유발계수_최대오차": err,
                         "부가가치율_범위": [float(va.min()), float(va.max())],
                         "총산출_합계_백만원": float(out.sum())}
        meta["levels"][key] = {"label": label, "sectors": sec}
        if key == "B":
            meta["mapping"] = {c: mp.get(c) for c in codes}
        print(label, len(codes), "오차", err)
    # 연장표(통합대분류 기준 취업·고용 등 20개 요약시트) -> summary.json
    wb = openpyxl.load_workbook(f"{RAW}/2023년_산업연관표_연장표_.xlsx", read_only=True, data_only=True)
    Ls = meta["levels"]["L"]["sectors"]
    summ = []
    for no, name in enumerate(wb.sheetnames):
        if no == 0 or no in (7, 8, 15): continue  # 목차, 소비·투자 구성, 최종수요 항목별 시트 제외
        names, rows = parse_summary(wb[name])
        out = {nm_: rows.get(ALIAS.get(c, nm(n))) for c, n in Ls for nm_ in [c]}
        out["ALL"] = rows.get("전산업")
        missing = [c for c, v in out.items() if v is None]
        report.setdefault("연장표_매칭누락", {})[name] = missing
        summ.append({"no": no, "name": name, "cols": [[n, col_unit(no, n)] for n in names], "rows": out})
    json.dump(summ, open(f"{OUT}/summary.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    # 상위 대분류 연결표(중·소·기본 -> 대분류)
    par = {"L": {c: c for c, _ in Ls}, "M": {}, "S": {}, "B": {}}
    for b, v in mp.items():
        par["B"][b], par["S"][v[0][0]], par["M"][v[1][0]] = v[2][0], v[2][0], v[2][0]
    meta["parent"] = par
    json.dump(meta, open(f"{OUT}/meta.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    json.dump(report, open("validation-report.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)


main()
