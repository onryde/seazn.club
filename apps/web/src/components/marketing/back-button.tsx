"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { ROUND_BACK_LOOK } from "@/components/back-link";

/** One back arrow at the top of every marketing subpage (12 Jul feedback).
 *  Browser back when there is history, home otherwise. */
export function BackButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      aria-label="Back"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push("/");
      }}
      className={`${ROUND_BACK_LOOK} h-9 w-9`}
    >
      <ArrowLeft className="h-4.5 w-4.5" strokeWidth={2} />
    </button>
  );
}
