export type Theme = "light" | "dark" | "system";

export interface ToastOptions {
  id?: string;
  title: string;
  description?: string;
  variant?: "info" | "success" | "warning" | "error";
  durationMs?: number;
}

export interface SidebarState {
  isOpen: boolean;
  width: number;
}
