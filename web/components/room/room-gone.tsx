import { useRouter } from "next/navigation";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { LivingRoom } from "@/components/living-room";
import { Wordmark } from "@/components/ui/wordmark";
import { Button } from "@/components/ui/button";

// Lights off: the room doesn't exist (typo, a code from somewhere else), or its owner
// ended it while we were inside ("you" when it was us, from another tab). The living room
// again, empty and dark.
export function RoomGone({ code, endedBy }: { code?: string; endedBy?: string }) {
  const router = useRouter();
  return (
    <main className="lobby-bg flex min-h-[100dvh] flex-col lg:grid lg:grid-cols-[540px_minmax(0,1fr)]">
      <div className="relative h-[260px] shrink-0 overflow-hidden rounded-b-[32px] sm:h-[340px] lg:sticky lg:top-0 lg:order-last lg:m-5 lg:ml-0 lg:h-[calc(100dvh-40px)] lg:rounded-[40px]">
        <LivingRoom variant="off" className="absolute inset-0" />
      </div>
      <section className="flex flex-1 flex-col px-5 pt-8 pb-[max(28px,env(safe-area-inset-bottom))] sm:px-10 lg:px-[72px] lg:py-10">
        <header className="max-lg:hidden">
          <Wordmark />
        </header>
        <div className="enter mx-auto flex w-full max-w-[440px] flex-1 flex-col gap-4 lg:mx-0 lg:max-w-[396px] lg:justify-center">
          <p className="font-mono text-[14px] tracking-[0.14em] text-plum-200">{code || "------"}</p>
          <h1 className="text-[36px] leading-[1.05] font-semibold tracking-[-0.035em] text-fog-50 sm:text-[48px]">
            {endedBy ? "The screening’s over." : "This room’s lights are off."}
          </h1>
          <p className="text-[17px] leading-relaxed text-fog-300">
            {endedBy === "you"
              ? "You ended this room. Its chat is gone and the code won’t work again."
              : endedBy
                ? `${endedBy} ended this room. Its chat is gone and the code won’t work again.`
                : "There’s no room with that code. Check it with whoever sent it, or start your own."}
          </p>
          <Button size="xl" onClick={() => router.push("/")} className="mt-3 h-[60px] w-full text-[17px]">
            <ArrowLeftIcon size={18} weight="bold" />
            Back to the lobby
          </Button>
        </div>
      </section>
    </main>
  );
}
