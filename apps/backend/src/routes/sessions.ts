import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";

const router = Router();

const createSessionBody = z.object({
  userId: z.string().min(1),
  title: z.string().max(200).optional(),
});

router.post("/", async (req, res, next) => {
  try {
    const parsed = createSessionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      return;
    }
    const { userId, title } = parsed.data;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const session = await prisma.session.create({
      data: {
        userId,
        title: title?.trim() ?? "",
      },
      select: {
        id: true,
        userId: true,
        title: true,
        summary: true,
        messageCount: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    res.status(201).json({ session: formatSession(session) });
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const userId = z.string().min(1).safeParse(req.query.userId);
    if (!userId.success) {
      res.status(400).json({ error: "Query userId is required" });
      return;
    }
    const sessions = await prisma.session.findMany({
      where: { userId: userId.data },
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: {
        id: true,
        userId: true,
        title: true,
        summary: true,
        messageCount: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    res.json({ sessions: sessions.map(formatSession) });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const sessionId = req.params.id;
    const userId = z.string().min(1).safeParse(req.query.userId);
    if (!userId.success) {
      res.status(400).json({ error: "Query userId is required" });
      return;
    }
    const session = await prisma.session.findFirst({
      where: { id: sessionId, userId: userId.data },
      select: {
        id: true,
        userId: true,
        title: true,
        summary: true,
        messageCount: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          where: { archived: false },
          orderBy: { seqNum: "asc" },
          select: {
            id: true,
            role: true,
            content: true,
            seqNum: true,
            createdAt: true,
          },
        },
      },
    });
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({
      session: formatSession(session),
      messages: session.messages.map((m) => ({
        id: m.id,
        sessionId: session.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

function formatSession(s: {
  id: string;
  userId: string;
  title: string;
  summary: string;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: s.id,
    userId: s.userId,
    title: s.title,
    summary: s.summary,
    messageCount: s.messageCount,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export default router;
