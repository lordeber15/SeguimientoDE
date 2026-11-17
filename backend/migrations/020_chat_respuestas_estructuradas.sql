-- Respuestas estructuradas del chat sin modelo de respuesta (docs/PLAN-CHAT-CONSULTAS.md, Fase 5):
-- 'documento' = tarjeta del último documento (con indicaciones de sus derivaciones) y
-- 'participantes' = remitentes, emisores, destinatarios y trámite con indicaciones. Sus datos van en
-- `meta` (para volver a pintarlos desde el historial sin re-consultar).
ALTER TABLE rag.chat_mensaje DROP CONSTRAINT IF EXISTS chat_mensaje_tipo_check;
ALTER TABLE rag.chat_mensaje
  ADD CONSTRAINT chat_mensaje_tipo_check
  CHECK (tipo IN ('texto', 'tabla', 'fijo', 'documento', 'participantes'));
