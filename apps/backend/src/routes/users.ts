import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/db/client";

const router = Router();

const createUserBody = z.object({
  fullName: z.string().min(1).max(200).trim(),
});

/** Display name from full name (first segment, max 80 chars). */
function deriveName(fullName: string): string {
  const first = fullName.split(/\s+/)[0] ?? fullName;
  return first.slice(0, 80) || fullName.slice(0, 80);
}

router.get("/", async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        name: true,
        fullName: true,
        createdAt: true,
      },
    });
    res.json({
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        fullName: u.fullName,
        createdAt: u.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const parsed = createUserBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      return;
    }
    const { fullName } = parsed.data;
    const name = deriveName(fullName);
    const user = await prisma.user.create({
      data: { name, fullName },
      select: { id: true, name: true, fullName: true, createdAt: true },
    });
    res.status(201).json({
      user: {
        id: user.id,
        name: user.name,
        fullName: user.fullName,
        createdAt: user.createdAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, fullName: true, createdAt: true },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({
      user: {
        id: user.id,
        name: user.name,
        fullName: user.fullName,
        createdAt: user.createdAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
