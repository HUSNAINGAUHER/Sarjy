import { Router } from "express";
import healthRouter from "@/routes/health";
import usersRouter from "@/routes/users";
import sessionsRouter from "@/routes/sessions";

const router = Router();

router.use("/health", healthRouter);
router.use("/api/users", usersRouter);
router.use("/api/sessions", sessionsRouter);

export default router;
