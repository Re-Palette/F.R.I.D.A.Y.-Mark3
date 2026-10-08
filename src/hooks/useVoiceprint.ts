"use client";

/** 登録した声紋（声紋認証）。開いたとき・画面に戻ったときに、ほかの端末での登録・変更を取り込む */
import { useEffect, useState } from "react";
import { currentVoiceprint, onVoiceprintChange, syncVoiceprint, type Voiceprint } from "@/lib/voiceprint";

export function useVoiceprint(): Voiceprint | null {
  const [print, setPrint] = useState<Voiceprint | null>(null);
  useEffect(() => {
    setPrint(currentVoiceprint());
    const off = onVoiceprintChange(() => setPrint(currentVoiceprint()));
    void syncVoiceprint();
    const onVisible = () => document.visibilityState === "visible" && void syncVoiceprint();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return print;
}
