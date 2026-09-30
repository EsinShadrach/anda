"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { SignOutIcon } from "@phosphor-icons/react";
import { api, cleanCode, type User } from "@/lib/api";
import { Projector } from "@/components/projector";
import { Wordmark } from "@/components/ui/wordmark";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { AuthPanel } from "@/components/home/auth-panel";
import { Lobby } from "@/components/home/lobby";

export default function Home() {
  const router = useRouter();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [next, setNext] = useState<string | null>(null);

  useEffect(() => {
    const n = new URLSearchParams(location.search).get("next");
    setNext(n?.startsWith("/room?") ? n : null);
    api.me().then(setUser, () => setUser(null));
  }, []);

  const inviteCode = next ? cleanCode(new URLSearchParams(next.slice(6)).get("code") ?? "") : undefined;

  function onAuthed(u: User) {
    if (next) {
      router.replace(next); // back to the invite that sent them here
      return;
    }
    setUser(u);
  }

  return (
    <main className="relative grid min-h-[100dvh] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <section className="flex flex-col px-5 pt-[max(12px,env(safe-area-inset-top))] pb-[max(28px,env(safe-area-inset-bottom))] sm:px-10 lg:px-14">
        {/* On phones the header floats over the top of the projector, so the brand leads. */}
        <header className="z-10 flex h-16 items-center justify-between max-lg:absolute max-lg:inset-x-2 max-lg:top-[max(8px,env(safe-area-inset-top))] max-lg:px-4 max-sm:h-14">
          <Wordmark />
          {user && <UserChip user={user} onSignedOut={() => setUser(null)} />}
        </header>
        <div className="flex max-w-[440px] flex-1 flex-col justify-center py-8 max-lg:pt-7 lg:py-12">
          {user === undefined ? (
            <HomeSkeleton />
          ) : user ? (
            <Lobby user={user} />
          ) : (
            <AuthPanel onAuthed={onAuthed} inviteCode={inviteCode || undefined} />
          )}
        </div>
      </section>
      <div className="order-first p-2 pb-0 sm:p-3 lg:order-none lg:p-3 lg:pl-0">
        <Projector className="relative h-[30svh] rounded-[24px] sm:h-[38svh] lg:sticky lg:top-3 lg:h-[calc(100dvh-24px)] lg:rounded-[28px]" />
      </div>
    </main>
  );
}

function UserChip({ user, onSignedOut }: { user: User; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <Link
        href="/me"
        title="Your profile and rooms"
        className="press mr-1 flex h-11 items-center gap-2.5 rounded-xl pr-3 pl-1.5 text-[14px] font-medium text-fog-300 hover:bg-white/5 hover:text-fog-50 max-sm:pr-1.5"
      >
        <Avatar name={user.username} size={28} />
        <span className="max-sm:hidden">{user.username}</span>
      </Link>
      <Button
        variant="ghost"
        size="icon"
        loading={busy}
        aria-label="Log out"
        title="Log out"
        onClick={async () => {
          setBusy(true);
          try {
            await api.logout();
            onSignedOut();
          } finally {
            setBusy(false);
          }
        }}
      >
        <SignOutIcon size={20} />
      </Button>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-label="Loading" aria-busy>
      <div className="skeleton h-11 w-4/5 rounded-xl" />
      <div className="skeleton h-11 w-3/5 rounded-xl" />
      <div className="skeleton mt-2 h-5 w-full rounded-lg" />
      <div className="skeleton h-5 w-2/3 rounded-lg" />
      <div className="skeleton mt-6 h-14 w-full max-w-[360px] rounded-2xl" />
    </div>
  );
}
