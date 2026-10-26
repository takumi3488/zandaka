import { useQuery } from "@tanstack/solid-query";

import { orpc } from "~/utils/orpc";

const TITLE_TEXT = `
 ██████╗ ███████╗████████╗████████╗███████╗██████╗
 ██╔══██╗██╔════╝╚══██╔══╝╚══██╔══╝██╔════╝██╔══██╗
 ██████╔╝█████╗     ██║      ██║   █████╗  ██████╔╝
 ██╔══██╗██╔══╝     ██║      ██║   ██╔══╝  ██╔══██╗
 ██████╔╝███████╗   ██║      ██║   ███████╗██║  ██║
 ╚═════╝ ╚══════╝   ╚═╝      ╚═╝   ╚══════╝╚═╝  ╚═╝

 ████████╗    ███████╗████████╗ █████╗  ██████╗██╗  ██╗
 ╚══██╔══╝    ██╔════╝╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝
    ██║       ███████╗   ██║   ███████║██║     █████╔╝
    ██║       ╚════██║   ██║   ██╔══██║██║     ██╔═██╗
    ██║       ███████║   ██║   ██║  ██║╚██████╗██║  ██╗
    ╚═╝       ╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝
 `;

export default function Home() {
  const healthCheck = useQuery(() => ({
    ...orpc.healthCheck.queryOptions(),
    deferStream: true,
  }));
  const isConnected = () => healthCheck.data === "OK";

  return (
    <div class="container mx-auto max-w-3xl px-4 py-2">
      <pre class="overflow-x-auto font-mono text-sm">{TITLE_TEXT}</pre>
      <div class="grid gap-6">
        <section class="rounded-lg border p-4">
          <h2 class="mb-2 font-medium">API Status</h2>
          <div class="flex items-center gap-2">
            <div
              class={`h-2 w-2 rounded-full ${healthCheck.isPending ? "bg-orange-400" : isConnected() ? "bg-green-500" : "bg-red-500"}`}
            />
            <span class="text-sm text-muted-foreground">
              {healthCheck.isPending ? "Checking..." : isConnected() ? "Connected" : "Disconnected"}
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
