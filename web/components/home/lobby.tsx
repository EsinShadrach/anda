import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { ApiError, rooms, type User } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { CodeInput } from "@/components/ui/code-input";
import { Spinner } from "@/components/ui/spinner";

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Morning";
  if (h < 17) return "Afternoon";
  return "Evening";
}

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
    <div className="flex flex-col gap-10">
      <div className="enter flex flex-col gap-4">
        <h1 className="text-[40px] leading-[1.02] font-semibold tracking-[-0.035em] text-fog-50 sm:text-5xl">
          {greeting()},
          <span className="block text-ember-400">{user.username}.</span>
        </h1>
        <p className="max-w-[40ch] text-[17px] leading-relaxed text-fog-300">
          Start a room and send the code. Everyone watches the same moment, with the chat alongside.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <Button size="lg" onClick={create} loading={creating} className="w-full max-w-[360px]">
          <PlusIcon size={20} weight="bold" />
          Start a room
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex max-w-[360px] items-center gap-3 text-[13px] font-medium text-fog-500">
          Have a code?
          <span className="h-px flex-1 bg-ink-700" />
        </div>
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
          ) : (
            <span className="text-fog-600">Six characters. Pasting a whole invite code works too.</span>
          )}
        </div>
      </div>
    </div>
  );
}
