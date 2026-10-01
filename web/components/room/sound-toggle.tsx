import { useSyncExternalStore } from "react";
import { BellSimpleIcon, BellSimpleSlashIcon } from "@phosphor-icons/react";
import { sounds } from "@/lib/sounds";

export function useSoundsOn() {
  return useSyncExternalStore(sounds.subscribe, sounds.getSnapshot, () => true);
}

/** Room sounds on or off (joins, leaves, messages, typing), remembered on this device. */
export function SoundToggle({ className = "" }: { className?: string }) {
  const on = useSoundsOn();
  return (
    <button
      onClick={() => sounds.setEnabled(!on)}
      aria-pressed={on}
      aria-label={on ? "Mute room sounds" : "Turn room sounds on"}
      title={on ? "Room sounds on: joins, messages, typing" : "Room sounds off"}
      className={`press grid size-9 shrink-0 place-items-center rounded-full hover:bg-white/8 ${on ? "text-fog-300" : "text-fog-600"} ${className}`}
    >
      {on ? <BellSimpleIcon size={18} /> : <BellSimpleSlashIcon size={18} />}
    </button>
  );
}
