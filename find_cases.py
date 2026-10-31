import pandas as pd, engine as E
D = E.load()
w = D.waste[D.waste.reason == "소비기한 경과"]
print("소비기한 경과 폐기 건수:", len(w))

cache, hits = {}, []
for ev in w.itertuples():
    for k in range(1, 7):                      # 폐기일 1~6일 전 발주 판단
        day = ev.date - pd.Timedelta(days=k)
        key = (ev.store_id, day)
        if key not in cache:
            cache[key] = E.recommend(D, ev.store_id, day)[0]
        r = cache[key][cache[key].ingredient_id == ev.ingredient_id].iloc[0]
        if r.rec_before > 0:
            hits.append(dict(store=ev.store_id, day=day.date(), waste_day=ev.date.date(),
                             품목=r.품목, rec_before=r.rec_before, rec=r.rec,
                             waste_before=round(r.waste_before), waste_after=round(r.waste_after),
                             adj_reason=r.adj_reason))

h = pd.DataFrame(hits).drop_duplicates(["store", "day", "품목"])
print(f"\n추천 발주가 있던 경우 {len(h)}건 / 그중 감량 {int((h.rec < h.rec_before).sum())}건")
print(h.sort_values("waste_before", ascending=False).head(15).to_string())