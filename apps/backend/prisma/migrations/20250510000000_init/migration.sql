-- Enable pgvector (required before tables using the `vector` type)
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant', 'system');

-- CreateEnum
CREATE TYPE "MemoryCategory" AS ENUM ('identity', 'preference', 'personality', 'constraint', 'ongoing');

-- CreateEnum
CREATE TYPE "MemoryVectorType" AS ENUM ('episodic', 'semantic');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "seqNum" INTEGER NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryFact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "MemoryCategory" NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "sourceSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryVector" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" "MemoryVectorType" NOT NULL,
    "sourceSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "embedding" vector(768),

    CONSTRAINT "MemoryVector_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_userId_updatedAt_idx" ON "Session"("userId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Message_sessionId_archived_seqNum_idx" ON "Message"("sessionId", "archived", "seqNum");

-- CreateIndex
CREATE UNIQUE INDEX "Message_sessionId_seqNum_key" ON "Message"("sessionId", "seqNum");

-- CreateIndex
CREATE INDEX "MemoryFact_userId_updatedAt_idx" ON "MemoryFact"("userId", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "MemoryFact_userId_key_key" ON "MemoryFact"("userId", "key");

-- CreateIndex
CREATE INDEX "MemoryVector_userId_idx" ON "MemoryVector"("userId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryFact" ADD CONSTRAINT "MemoryFact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryVector" ADD CONSTRAINT "MemoryVector_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
