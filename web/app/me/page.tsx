"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, SignOutIcon } from "@phosphor-icons/react";
import { api, type User } from "@/lib/api";
import { Projector } from "@/components/projector";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { RoomList } from "@/components/profile/room-list";

// Your profile: who you are, and every room you've been in, to rejoin or end.
export default function Profile() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    api.me().then(setUser, () => router.replace("/"));
  }, [router]);

  return (
    <main className="relative grid min-h-[100dvh] lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      <section className="flex flex-col px-5 pt-[max(12px,env(safe-area-inset-top))] pb-[max(28px,env(safe-area-inset-bottom))] sm:px-10 lg:px-14">
        <header className="flex h-16 items-center justify-between max-sm:h-14">
          <Button variant="ghost" onClick={() => router.push("/")} className="-ml-3 px-3">
            <ArrowLeftIcon size={18} weight="bold" />
            Lobby
          </Button>
          <Button
            variant="ghost"
            loading={signingOut}
            onClick={async () => {
              setSigningOut(true);
              try {
                await api.logout();
                router.replace("/");
              } catch {
                setSigningOut(false);
              }
            }}
          >
            <SignOutIcon size={18} />
            Log out
          </Button>
        </header>

        <div className="flex w-full max-w-[640px] flex-col gap-10 py-8 lg:py-14">
          {user ? (
            <div className="enter flex items-center gap-5">
              <Avatar name={user.username} size={72} />
              <div className="flex min-w-0 flex-col gap-1">
                <h1 className="truncate text-[36px] leading-[1.05] font-semibold tracking-[-0.035em] text-fog-50 sm:text-[44px]">
                  {user.username}
                </h1>
                <p className="h-5 text-[15px] text-fog-500">
                  {count === null ? "" : count === 1 ? "1 room" : `${count} rooms`}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-5" aria-hidden>
              <div className="skeleton size-[72px] rounded-full" />
              <div className="flex flex-col gap-2.5">
                <div className="skeleton h-10 w-48 rounded-xl" />
                <div className="skeleton h-4 w-20 rounded-md" />
              </div>
            </div>
          )}

          <section className="flex flex-col gap-4" aria-labelledby="rooms-title">
            <div className="flex flex-col gap-1">
              <h2 id="rooms-title" className="text-[20px] font-semibold tracking-[-0.02em] text-fog-50">
                Your rooms
              </h2>
              <p className="text-[14px] text-fog-500">
                Rejoin any of them. Rooms you started can be ended for good; others you can take off your list.
              </p>
            </div>
            <RoomList onCount={setCount} />
          </section>
        </div>
      </section>
      <div className="p-3 pl-0 max-lg:hidden">
        <Projector className="sticky top-3 h-[calc(100dvh-24px)] rounded-[28px]" />
      </div>
    </main>
  );
}
