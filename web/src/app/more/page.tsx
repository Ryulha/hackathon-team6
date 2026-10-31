"use client";

import Link from "next/link";
import { CALC_KEYS, DemoControls } from "@/components/settings-panel";
import { DEFAULT_SETTINGS } from "@/lib/engine";
import { useApp } from "@/state/app-state";

/** 매일 쓰지 않는 화면 모음 — 기존 상세 화면은 그대로, 위치만 여기로 */
const LINKS = [
  { href: "/overview", title: "한눈에 보기", desc: "오늘 할 일·곧 떨어지는 품목·다가오는 주문을 한 화면에" },
  { href: "/orders", title: "발주 상세", desc: "모든 품목의 추천 수량을 표로 보고 고치기, 임시 저장" },
  { href: "/inventory", title: "재고·사용기한", desc: "품목별 남은 양과 며칠 분량, 재고 흐름 차트, 폐기 원인" },
  { href: "/inputs", title: "기준정보·판매 업로드", desc: "공급사 조건·포장 단위·단가 수정, 판매 기록 올리기, 실사 표로 입력" },
  { href: "/settings", title: "추천 설정", desc: "얼마나 넉넉하게 주문할지, 수요 증감, 행사 가정, 알림 기준" },
  { href: "/assumptions", title: "가정·근거", desc: "계산 방식, 백테스트, 데이터 검증 결과, 용어 사전" },
];

export default function MorePage() {
  const { settings } = useApp();
  const changed = CALC_KEYS.filter((k) => settings[k] !== DEFAULT_SETTINGS[k]).length;
  return (
    <>
      <header>
        <h2 className="text-2xl font-bold tracking-[-0.02em]">더보기</h2>
        <p className="hint mt-1">매일 쓰지 않는 상세 화면과 설정입니다.</p>
      </header>

      <ul className="grid gap-2 sm:grid-cols-2">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="card flex h-full items-start justify-between gap-3 hover:bg-[var(--surface-2)]">
              <span>
                <b>{l.title}</b>
                {l.href === "/settings" && changed > 0 && <span className="badge badge-accent ml-1.5">{changed}개 변경</span>}
                <span className="hint mt-0.5 block">{l.desc}</span>
              </span>
              <span aria-hidden className="text-[var(--muted)]">→</span>
            </Link>
          </li>
        ))}
      </ul>

      <section className="card flex flex-col gap-3">
        <div>
          <h3 className="section-title">시연용: 날짜·시각 바꾸기</h3>
          <p className="hint">실제 매장에서는 바꿀 일이 없는 값입니다. 조건을 바꾸면 모든 화면의 추천이 바로 다시 계산됩니다.</p>
        </div>
        <DemoControls />
      </section>
    </>
  );
}
