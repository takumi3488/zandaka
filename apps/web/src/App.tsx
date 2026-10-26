import { Title } from "@solidjs/meta";
import { QueryClientProvider } from "@tanstack/solid-query";
import { Loading } from "solid-js";

import Header from "~/components/header";
import Loader from "~/components/loader";
import { Router } from "~/router";
import { createQueryClient } from "~/utils/orpc";

import "./styles.css";
import "./pwa-registration";

export default function App() {
  const queryClient = createQueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        {(props) => (
          <>
            <Title>zandaka</Title>
            <div class="grid h-svh grid-rows-[auto_1fr]">
              <Header />
              <Loading fallback={<Loader />}>{props.children}</Loading>
            </div>
          </>
        )}
      </Router>
    </QueryClientProvider>
  );
}
