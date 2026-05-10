import { generateText } from "ai";
import type { ModelMessage } from "ai";
import { prisma } from "@/db/client";
import { getMemoryLlmModel, getMemoryLlmProviderOptions } from "@/services/memoryModel";
import { logger } from "@/utils/logger";
import type { Message as PrismaMessage } from "@prisma/client";

const MAX_ACTIVE_MESSAGES = 30;
const KEEP_LAST = 5;

export async function loadConversationForVoice(params: {
  sessionId: string;
  userId: string;
}): Promise<ModelMessage[]> {
  const session = await prisma.session.findFirst({
    where: { id: params.sessionId, userId: params.userId },
    include: {
      messages: {
        where: { archived: false },
        orderBy: { seqNum: "asc" },
      },
    },
  });
  if (!session) return [];

  return session.messages.map(dbMessageToModelMessage);
}

function dbMessageToModelMessage(m: PrismaMessage): ModelMessage {
  const role =
    m.role === "system" ? "system" : m.role === "user" ? "user" : "assistant";
  return { role, content: m.content };
}

export async function persistVoiceExchange(params: {
  sessionId: string;
  userId: string;
  userText: string;
  assistantText: string;
}): Promise<void> {
  const session = await prisma.session.findFirst({
    where: { id: params.sessionId, userId: params.userId },
  });
  if (!session) {
    logger.warn("persistVoiceExchange: session not found", {
      sessionId: params.sessionId,
      userId: params.userId,
    });
    return;
  }

  const maxRow = await prisma.message.aggregate({
    where: { sessionId: params.sessionId },
    _max: { seqNum: true },
  });
  let nextSeq = (maxRow._max.seqNum ?? 0) + 1;

  await prisma.$transaction(async (tx) => {
    await tx.message.create({
      data: {
        sessionId: params.sessionId,
        role: "user",
        content: params.userText,
        seqNum: nextSeq++,
      },
    });
    await tx.message.create({
      data: {
        sessionId: params.sessionId,
        role: "assistant",
        content: params.assistantText,
        seqNum: nextSeq++,
      },
    });

    const titleUpdate =
      !session.title?.trim() && params.userText.trim()
        ? params.userText.trim().slice(0, 120)
        : undefined;

    const activeCount = await tx.message.count({
      where: { sessionId: params.sessionId, archived: false },
    });

    await tx.session.update({
      where: { id: params.sessionId },
      data: {
        messageCount: activeCount,
        ...(titleUpdate ? { title: titleUpdate } : {}),
      },
    });
  });

  await compressSessionIfNeeded(params.sessionId);
}

async function compressSessionIfNeeded(sessionId: string): Promise<void> {
  const active = await prisma.message.findMany({
    where: { sessionId, archived: false },
    orderBy: { seqNum: "asc" },
  });

  if (active.length <= MAX_ACTIVE_MESSAGES) return;

  const toFold = active.slice(0, active.length - KEEP_LAST);
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return;

  const transcript = toFold
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const prior = session.summary?.trim();
  const summaryText = await summarizeConversationChunk({
    priorSummary: prior,
    transcript,
  });

  const maxSeqRow = await prisma.message.aggregate({
    where: { sessionId },
    _max: { seqNum: true },
  });
  const nextSeq = (maxSeqRow._max.seqNum ?? 0) + 1;

  await prisma.$transaction(async (tx) => {
    await tx.message.updateMany({
      where: { id: { in: toFold.map((m) => m.id) } },
      data: { archived: true },
    });
    await tx.message.create({
      data: {
        sessionId,
        role: "system",
        content: `Earlier conversation (compressed): ${summaryText}`,
        seqNum: nextSeq,
      },
    });
    const newActiveCount = await tx.message.count({
      where: { sessionId, archived: false },
    });
    await tx.session.update({
      where: { id: sessionId },
      data: {
        summary: [prior, summaryText].filter(Boolean).join("\n\n").slice(0, 12_000),
        messageCount: newActiveCount,
      },
    });
  });

  logger.info("Session buffer compressed", {
    sessionId,
    foldedCount: toFold.length,
    remainingActive: KEEP_LAST + 1,
  });
}

async function summarizeConversationChunk(params: {
  priorSummary: string | undefined;
  transcript: string;
}): Promise<string> {
  const prompt = [
    "You compress older chat turns for a voice assistant.",
    "Output plain prose only: one short paragraph (max ~120 words). No bullets, no markdown.",
    "Preserve names, places, goals, decisions, and open questions the user cares about.",
    params.priorSummary
      ? `Existing running summary (merge and dedupe; do not repeat verbatim if redundant):\n${params.priorSummary}\n`
      : "",
    "Messages to fold into the summary:\n",
    params.transcript,
  ].join("\n");

  const { text } = await generateText({
    model: getMemoryLlmModel(),
    prompt,
    maxOutputTokens: 256,
    temperature: 0.3,
    ...getMemoryLlmProviderOptions(),
  });
  return text.trim() || "Earlier topics were discussed; details were summarized.";
}
