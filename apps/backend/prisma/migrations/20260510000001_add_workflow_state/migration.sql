-- Add workflowState column to Session for durable workflow FSM persistence.
-- Uses JSONB for fast key-based queries and efficient storage.
ALTER TABLE "Session" ADD COLUMN "workflowState" JSONB;
