"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, cleanCode } from "@/lib/api";
import { RoomView } from "@/components/room/room-view";
import { RoomGone } from "@/components/room/room-gone";
import { Projector } from "@/components/projector";

export default function RoomPage() {
  return (
    <Suspense fallback={<Entering />}>
      <RoomGate />
    </Suspense>
  );
}

// Signed-out visitors (from an invite link) sign in first, then come straight back here.
function RoomGate() {
  const router = useRouter();
  const code = cleanCode(useSearchParams().get("code") ?? "");
  const [ok, setOk] = useState(false);

  useEffect(() => {
    if (code.length !== 6) return;
    api.me().then(
      () => setOk(true),
      () => router.replace(`/?next=${encodeURIComponent(`/room?code=${code}`)}`),
    );
  }, [router, code]);

  if (code.length !== 6) return <RoomGone />;
  return ok ? <RoomView code={code} /> : <Entering />;
}

function Entering() {
  return <Projector variant="stage" className="fixed inset-0" />;
}
