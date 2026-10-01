"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, cleanCode, type User } from "@/lib/api";
import { Wordmark } from "@/components/ui/wordmark";
import { UserMenu } from "@/components/home/user-menu";
import { SignIn } from "@/components/home/sign-in";
import { Lobby } from "@/components/home/lobby";

export default function Home() {
  const router = useRouter();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [next, setNext] = useState<string | null>(null);

  useEffect(() => {
    const n = new URLSearchParams(location.search).get("next");
    const room = n?.startsWith("/room?") ? n : null;
    setNext(room);
    // Already signed in (another tab did it): straight on to the invite.
    api.me().then((u) => (room ? router.replace(room) : setUser(u)), () => setUser(null));
  }, [router]);

  const inviteCode = next ? cleanCode(new URLSearchParams(next.slice(6)).get("code") ?? "") : undefined;

  function onAuthed(u: User) {
    if (next) {
      router.replace(next); // back to the invite that sent them here
      return;
    }
    setUser(u);
  }

  if (user === null || (user === undefined && next)) {
    return <SignIn inviteCode={inviteCode || undefined} onAuthed={onAuthed} />;
  }

  // Signed in, or not known yet (most visits are returning people, so the lobby's shell).
  return (
    <main className="lobby-bg min-h-[100dvh]">
      <div className="mx-auto flex min-h-[100dvh] max-w-[1320px] flex-col px-5 pt-[max(8px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))] sm:px-10 lg:px-14">
        <header className="flex h-20 shrink-0 items-center justify-between max-sm:h-16">
          <Wordmark />
          {user && <UserMenu user={user} onSignedOut={() => setUser(null)} />}
        </header>
        {user ? (
          <Lobby user={user} />
        ) : (
          <div className="flex flex-1 items-center py-12">
            <HomeSkeleton />
          </div>
        )}
      </div>
    </main>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex w-full max-w-[560px] flex-col gap-4" aria-label="Loading" aria-busy>
      <div className="skeleton h-16 w-4/5 rounded-full" />
      <div className="skeleton mt-2 h-5 w-full rounded-full" />
      <div className="skeleton h-5 w-2/3 rounded-full" />
      <div className="skeleton mt-8 h-16 w-56 rounded-full" />
    </div>
  );
}
