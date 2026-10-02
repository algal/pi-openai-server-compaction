import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const notePrompt = "Reply only with the token from the injected extension note.";
export const noteToken = "CUSTOM-NOTE-48-DELTA";

export default function contextNote(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (event.prompt !== notePrompt) return;
    return {
      message: {
        customType: "compaction-live-note",
        content: `The extension note token is ${noteToken}.`,
        display: false,
      },
    };
  });
}
