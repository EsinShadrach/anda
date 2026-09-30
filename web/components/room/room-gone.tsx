import { useRouter } from "next/navigation";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { Projector } from "@/components/projector";
import { Button } from "@/components/ui/button";

// Lights off: the room doesn't exist (typo, or a code from somewhere else).
export function RoomGone({ code }: { code?: string }) {
  const router = useRouter();
  return (
    <Projector variant="off" className="relative grid min-h-[100dvh] place-items-center px-5">
      <div className="enter relative z-10 flex max-w-[380px] flex-col items-center gap-4 text-center">
        <p className="font-mono text-[13px] tracking-[0.2em] text-fog-600">{code || "------"}</p>
        <h1 className="text-[32px] leading-[1.05] font-semibold tracking-[-0.03em] text-fog-50">
          This room&rsquo;s lights are off
        </h1>
        <p className="text-[16px] leading-relaxed text-fog-300">
          There&rsquo;s no room with that code. Check it with whoever sent it, or start your own.
        </p>
        <Button size="lg" onClick={() => router.push("/")} className="mt-3">
          <ArrowLeftIcon size={18} weight="bold" />
          Back to the lobby
        </Button>
      </div>
    </Projector>
  );
}
