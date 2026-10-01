"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { api, type User } from "@/lib/api";
import { Wordmark } from "@/components/ui/wordmark";
import { UserMenu } from "@/components/home/user-menu";
import { RoomList } from "@/components/profile/room-list";

// Your profile: every room you've been in, to rejoin, end or take off your list.
export default function Profile() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    api.me().then(setUser, () => router.replace("/"));
  }, [router]);

  return (
    <main className="lobby-bg min-h-[100dvh]">
      <div className="mx-auto flex min-h-[100dvh] max-w-[1320px] flex-col px-5 pt-[max(8px,env(safe-area-inset-top))] pb-[max(96px,env(safe-area-inset-bottom))] sm:px-10 lg:px-14">
        <header className="flex h-20 shrink-0 items-center justify-between max-sm:h-16">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push("/")}
              aria-label="Back to the lobby"
              className="press grid size-11 place-items-center rounded-full bg-ink-800 text-fog-100 hover:bg-ink-700"
            >
              <ArrowLeftIcon size={20} />
            </button>
            <Wordmark />
          </div>
          {user && <UserMenu user={user} rooms={false} onSignedOut={() => router.replace("/")} />}
        </header>

        <div className="flex flex-col gap-2 pt-10 pb-8 sm:pt-14">
          <h1 className="text-[36px] leading-[1.05] font-semibold tracking-[-0.035em] text-fog-50 sm:text-[44px]">Rooms you&rsquo;ve been in</h1>
          <p className="h-5 text-[15px] text-fog-500">
            {count === null ? "" : count === 0 ? "" : `${count === 1 ? "1 room" : `${count} rooms`}. Rejoin any of them; rooms you started can be ended for good.`}
          </p>
        </div>
        <RoomList me={user?.username} onCount={setCount} />
      </div>
    </main>
  );
}
