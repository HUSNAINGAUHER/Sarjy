import axios from "axios";
import { env } from "@/lib/env";

export const apiClient = axios.create({
  baseURL: env.apiUrl,
  withCredentials: false,
  headers: {
    "Content-Type": "application/json",
  },
});
