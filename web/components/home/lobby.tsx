import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRightIcon, CouchIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { ApiError, rooms, type User, type VisitedRoom } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { CodeInput } from "@/components/ui/code-input";
import { Spinner } from "@/components/ui/spinner";
import { Poster, Presence, roomTitle } from "@/components/profile/room-bits";

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Morning";
  if (h < 17) return "Afternoon";
  return "Evening";
}

const RECENT = 3;

export function Lobby({ user }: { user: User }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [shake, setShake] = useState(0);

  async function create() {
    setError("");
    setCreating(true);
    try {
      const room = await rooms.create();
      router.push(`/room?code=${room.code}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reach Anda. Try again.");
      setCreating(false);
    }
  }

  // Joins as soon as the sixth character lands; no button to hunt for.
  async function join(c: string) {
    setError("");
    setChecking(true);
    try {
      const room = await rooms.get(c);
      router.push(`/room?code=${room.code}`);
    } catch (err) {
      setChecking(false);
      setError(
        err instanceof ApiError && err.status === 404
          ? `No room with code ${c}. Check it with whoever sent it.`
          : "Couldn't reach Anda. Try again.",
      );
      setShake((n) => n + 1);
    }
  }

  return (
    <div className="grid flex-1 content-center items-center gap-12 py-8 lg:grid-cols-[minmax(0,1fr)_440px] lg:gap-20 lg:py-12">
      <section className="flex flex-col gap-8 sm:gap-10">
        <div className="enter flex flex-col gap-5">
          <h1 className="text-[44px] leading-[1.02] font-semibold tracking-[-0.04em] text-fog-50 sm:text-[68px]">
            {greeting()}, <span className="text-plum-200 max-sm:block">{user.username}.</span>
          </h1>
          <p className="max-w-[34ch] text-[18px] leading-relaxed text-fog-300 max-sm:hidden sm:text-[20px]">
            Start a room, send the code, and everyone watches the same film at the same moment.
          </p>
        </div>

        <Button size="xl" onClick={create} loading={creating} className="w-fit max-sm:w-full">
          <CouchIcon size={22} weight="bold" />
          Start a room
        </Button>

        <div className="flex flex-col gap-3">
          <p className="text-[14px] text-fog-500">Got a code?</p>
          <CodeInput
            value={code}
            onChange={(c) => {
              setCode(c);
              if (error) setError("");
            }}
            onComplete={join}
            invalid={!!error}
            disabled={checking}
            shakeKey={shake}
          />
          <div className="min-h-5 text-[14px]" aria-live="polite">
            {checking ? (
              <span className="inline-flex items-center gap-2 text-fog-500">
                <Spinner size={14} /> Finding room {code}
              </span>
            ) : error ? (
              <span className="inline-flex items-start gap-2 text-danger">
                <WarningCircleIcon size={17} weight="fill" className="mt-px shrink-0" />
                {error}
              </span>
            ) : null}
          </div>
        </div>
      </section>

      <RecentRooms me={user.username} />
    </div>
  );
}

// The last few rooms, to walk straight back into.
function RecentRooms({ me }: { me: string }) {
  const [list, setList] = useState<VisitedRoom[] | null>(null);

  useEffect(() => {
    const load = () => rooms.visited().then(setList, () => setList((l) => l ?? []));
    load();
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  if (list && list.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="recent-title">
      <h2 id="recent-title" className="px-2 text-[16px] font-semibold text-fog-300">
        Pick up where you left off
      </h2>
      <ul className="flex flex-col gap-3">
        {list === null
          ? [0, 1].map((i) => <li key={i} className="skeleton h-[140px] rounded-[32px]" aria-hidden />)
          : list.slice(0, RECENT).map((r) => <RoomCard key={r.code} room={r} me={me} />)}
      </ul>
      {list && list.length > 0 && (
        <Link
          href="/me"
          className="mt-1 inline-flex w-fit items-center gap-1.5 px-2 text-[14px] font-medium text-plum-200 transition-opacity hover:opacity-80"
        >
          All your rooms <ArrowRightIcon size={14} />
        </Link>
      )}
    </section>
  );
}

function RoomCard({ room, me }: { room: VisitedRoom; me: string }) {
  const router = useRouter();
  const live = room.online > (room.here?.includes(me) ? 1 : 0);
  return (
    <li className="enter flex items-center gap-4 rounded-[32px] bg-ink-800 p-4">
      <Poster room={room} className="h-[108px] w-[72px] shrink-0 rounded-[16px] max-sm:h-24 max-sm:w-16" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="truncate text-[18px] font-semibold tracking-[-0.01em] text-fog-50">{roomTitle(room)}</p>
        <Presence room={room} me={me} />
      </div>
      <Button variant={live ? "primary" : "secondary"} onClick={() => router.push(`/room?code=${room.code}`)} className="h-12 px-5">
        Rejoin
      </Button>
    </li>
  );
}
