import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CouchIcon, SignOutIcon } from "@phosphor-icons/react";
import { api, type User } from "@/lib/api";
import { Avatar } from "@/components/ui/avatar";
import { MenuItem, Popover } from "@/components/ui/popover";

// You, top right: your rooms and logging out.
export function UserMenu({ user, onSignedOut, rooms = true }: { user: User; onSignedOut: () => void; rooms?: boolean }) {
  const router = useRouter();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={ref}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Signed in as ${user.username}`}
        className={`press flex h-12 items-center gap-3 rounded-full bg-ink-800 p-1.5 text-[15px] font-medium text-fog-100 hover:bg-ink-700 ${rooms ? "sm:pl-4" : ""}`}
      >
        {rooms && <span className="max-sm:hidden">{user.username}</span>}
        <Avatar name={user.username} size={36} self />
      </button>
      <Popover anchor={ref.current} open={open} onClose={() => setOpen(false)} placement="bottom" label="You" className="w-[220px]">
        {rooms && (
          <MenuItem icon={<CouchIcon size={18} />} onClick={() => router.push("/me")}>
            Your rooms
          </MenuItem>
        )}
        <MenuItem
          icon={<SignOutIcon size={18} />}
          onClick={async () => {
            setOpen(false);
            try {
              await api.logout();
            } finally {
              onSignedOut();
            }
          }}
        >
          Log out
        </MenuItem>
      </Popover>
    </>
  );
}
