import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// Claude 风字体:Figtree(近似 Styrene B)+ JetBrains Mono(近似 Berkeley Mono);
// 中文回退系统微软雅黑(claude.ai 对中文同样走系统字体)
import "@fontsource-variable/figtree";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
