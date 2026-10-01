import { useEffect, useState } from "react";
import { ApiError, rooms, type Invite, type User } from "@/lib/api";
import { LivingRoom } from "@/components/living-room";
import { Wordmark } from "@/components/ui/wordmark";
import { AuthPanel } from "./auth-panel";

const list = new Intl.ListFormat(undefined, { style: "long", type: "conjunction" });

// Signed out: the living room beside the form on desktop, above it on phones and tablets.
// From an invite link it says whose room it is and who's already on the couch.
export function SignIn({ inviteCode, onAuthed }: { inviteCode?: string; onAuthed: (u: User) => void }) {
  const [invite, setInvite] = useState<Invite | "missing" | null | undefined>(undefined);

  useEffect(() => {
    if (!inviteCode) return;
    rooms.invite(inviteCode).then(setInvite, (e) => setInvite(e instanceof ApiError && e.status === 404 ? "missing" : null));
  }, [inviteCode]);

  return (
    <main className="lobby-bg flex min-h-[100dvh] flex-col lg:grid lg:grid-cols-[540px_minmax(0,1fr)]">
      <div className="relative h-[310px] shrink-0 overflow-hidden rounded-b-[32px] sm:h-[380px] lg:sticky lg:top-0 lg:order-last lg:m-5 lg:ml-0 lg:h-[calc(100dvh-40px)] lg:rounded-[40px]">
        <LivingRoom className="absolute inset-0" />
        {inviteCode && invite && invite !== "missing" && <CouchPill invite={invite} />}
      </div>
      <section className="flex flex-1 flex-col px-5 pt-7 pb-[max(28px,env(safe-area-inset-bottom))] sm:px-10 lg:px-[72px] lg:py-10">
        <header className="max-lg:hidden">
          <Wordmark />
        </header>
        <div className="mx-auto flex w-full max-w-[440px] flex-1 flex-col lg:mx-0 lg:max-w-[396px] lg:justify-center">
          <AuthPanel onAuthed={onAuthed} inviteCode={inviteCode} invite={inviteCode ? invite : undefined} />
        </div>
      </section>
    </main>
  );
}

// "● K7Q2FM  Rafe and Juno are on the couch", over the scene. Phones drop the code (the
// invite card below already shows it) and tuck the pill under the status bar.
function CouchPill({ invite }: { invite: Invite }) {
  const names = invite.here ?? [];
  const extra = invite.online - names.length;
  const who = names.length ? list.format(extra > 0 ? [...names, `${extra} more`] : names) : "";
  return (
    <div className="enter absolute top-[max(12px,calc(env(safe-area-inset-top)+8px))] left-3 z-[1] flex h-9 max-w-[calc(100%-24px)] items-center gap-2.5 rounded-full bg-ink-800/85 px-3.5 backdrop-blur-md lg:top-7 lg:left-7 lg:h-11 lg:max-w-[calc(100%-56px)] lg:px-[18px]">
      <span className={`size-2 shrink-0 rounded-full ${invite.online > 0 ? "bg-live" : "bg-fog-600"}`} />
      <span className="font-mono text-[14px] font-medium tracking-[0.14em] text-plum-200 max-lg:hidden">{invite.code}</span>
      <span className="truncate text-[13px] text-fog-300 lg:text-[14px]">
        {invite.online > 0 ? `${who} ${invite.online === 1 ? "is" : "are"} on the couch` : "Nobody\u2019s on the couch yet"}
      </span>
    </div>
  );
}
