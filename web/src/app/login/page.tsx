"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";

/** 심사·시연용 테스트 계정 (매장마다 관리자 1명) — README 에도 같은 내용 */
const DEMO = [
  { username: "s01", password: "cheese01!", store: "가상매장 A", note: "오피스 상권 · 대형" },
  { username: "s02", password: "cheese02!", store: "가상매장 B", note: "주거·역세권" },
  { username: "s03", password: "cheese03!", store: "가상매장 C", note: "" },
];

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }),
      });
      if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? "로그인하지 못했습니다."); return; }
      // 로그인 전에 열려던 화면으로 (같은 사이트 경로만)
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    } catch {
      setError("서버에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.15fr_1fr]">
      {/* 브랜드 패널 — 공식 홈페이지처럼 어두운 배경 위 큰 흰 글씨 */}
      <section className="relative flex flex-col justify-between overflow-hidden px-8 py-10 text-white lg:px-14 lg:py-14"
        style={{ background: "radial-gradient(120% 90% at 85% 110%, rgb(255 204 0 / 0.28), transparent 55%), #141412" }}>
        <Image src="/brand/crycheese-logo.webp" alt="크라이치즈버거" width={220} height={58} priority
          className="h-auto w-44 lg:w-52" style={{ filter: "drop-shadow(0 1px 0 rgb(0 0 0 / 0.4))" }} />
        <div className="my-12 lg:my-0">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/25 px-3 py-1 text-xs font-medium text-white/80">
            매장 관리자 전용 · 식자재 발주 도우미
          </p>
          <h1 className="text-[40px] leading-[1.15] font-extrabold tracking-[-0.03em] lg:text-[56px]">
            좋은 재료는<br />딱 맞게 주문합니다.
          </h1>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-white/70">
            판매 추세, 남은 재고와 사용기한, 공급사 발주 조건을 함께 따져 오늘 무엇을 얼마나 주문할지 알려드려요.
          </p>
        </div>
        <p className="text-xs text-white/40">합성 데이터 기반 해커톤 프로토타입 · 발주 전송은 모의 기능입니다</p>
        <Image src="/icon.png" alt="" width={260} height={260} aria-hidden
          className="pointer-events-none absolute -right-14 -bottom-16 hidden w-64 opacity-90 select-none lg:block" />
      </section>

      {/* 로그인 폼 */}
      <section className="flex items-center justify-center px-6 py-12" style={{ background: "var(--surface)" }}>
        <div className="w-full max-w-sm">
          <h2 className="text-2xl font-bold tracking-[-0.02em]">매장 관리자 로그인</h2>
          <p className="hint mt-1 !text-sm">매장마다 관리자 계정이 하나씩 있습니다. 로그인하면 내 매장 데이터만 보입니다.</p>

          <form onSubmit={submit} className="mt-8 flex flex-col gap-4" noValidate>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">아이디</span>
              <input className="input !rounded-full !px-4 !py-2.5" autoComplete="username" autoFocus value={username}
                onChange={(e) => setUsername(e.target.value)} placeholder="예: s01" aria-invalid={!!error} />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">비밀번호</span>
              <span className="relative">
                <input className="input w-full !rounded-full !py-2.5 !pr-16 !pl-4" type={show ? "text" : "password"} autoComplete="current-password"
                  value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} />
                <button type="button" className="btn-ghost absolute top-1/2 right-1.5 -translate-y-1/2 !rounded-full !px-2.5 !py-1 text-xs"
                  onClick={() => setShow((v) => !v)} aria-label={show ? "비밀번호 숨기기" : "비밀번호 보기"}>{show ? "숨기기" : "보기"}</button>
              </span>
            </label>
            {error && <div role="alert" className="status status-err">{error}</div>}
            <button type="submit" className="btn-primary mt-1 !rounded-full !py-3 !text-[15px] !font-bold" disabled={busy || !username || !password}>
              {busy ? "확인 중…" : "로그인"} {!busy && <span aria-hidden>→</span>}
            </button>
          </form>

          <div className="mt-10 rounded-2xl border p-4" style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}>
            <p className="text-sm font-semibold">심사용 테스트 계정</p>
            <p className="hint mb-3">누르면 아이디와 비밀번호가 채워집니다.</p>
            <ul className="flex flex-col gap-2">
              {DEMO.map((d) => (
                <li key={d.username}>
                  <button type="button" className="btn w-full justify-between !rounded-full !px-4"
                    onClick={() => { setUsername(d.username); setPassword(d.password); setError(""); }}>
                    <span className="font-semibold">{d.store}<span className="hint ml-1.5 font-normal">{d.note}</span></span>
                    <span className="font-mono text-xs text-[var(--muted)]">{d.username} / {d.password}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
