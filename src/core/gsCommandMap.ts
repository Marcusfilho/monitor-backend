/**
 * gsCommandMap.ts — Lookup G-Sensor label × harness → comando de calibração
 *
 * GS_COMMAND_MAP_V1
 * 24 combinações pré-configuradas.
 * Chave: "LABEL|HARNESS" (ambos em UPPER_CASE).
 *
 * action_id : identificador semântico (usado em logs e no payload)
 * command_syntax: comando o2w enviado ao dispositivo
 */

export interface GsCommand {
  action_id: string;
  command_syntax: string;
}

export const GS_COMMAND_MAP: Record<string, GsCommand> = {
  "UP|BACK":     { action_id: "GS_UP_BACK",     command_syntax: "(o2w,44,C614FC00000000000000FC0000000000000004000000)" },
  "UP|FRONT":    { action_id: "GS_UP_FRONT",    command_syntax: "(o2w,44,C6140400000000000000040000000000000004000000)" },
  "UP|RIGHT":    { action_id: "GS_UP_RIGHT",    command_syntax: "(o2w,44,C6140000FC0000000400000000000000000004000000)" },
  "UP|LEFT":     { action_id: "GS_UP_LEFT",     command_syntax: "(o2w,44,C614000004000000FC00000000000000000004000000)" },
  "FRONT|RIGHT": { action_id: "GS_FRONT_RIGHT", command_syntax: "(o2w,44,C61400000000FC000400000000000000FC0000000000)" },
  "FRONT|DOWN":  { action_id: "GS_FRONT_DOWN",  command_syntax: "(o2w,44,C61400000000FC000000040000000400000000000000)" },
  "FRONT|LEFT":  { action_id: "GS_FRONT_LEFT",  command_syntax: "(o2w,44,C61400000000FC00FC00000000000000040000000000)" },
  "FRONT|UP":    { action_id: "GS_FRONT_UP",    command_syntax: "(o2w,44,C61400000000FC000000FC000000FC00000000000000)" },
  "LEFT|BACK":   { action_id: "GS_LEFT_BACK",   command_syntax: "(o2w,44,C614FC00000000000000000004000000040000000000)" },
  "LEFT|FRONT":  { action_id: "GS_LEFT_FRONT",  command_syntax: "(o2w,44,C61404000000000000000000FC000000040000000000)" },
  "LEFT|DOWN":   { action_id: "GS_LEFT_DOWN",   command_syntax: "(o2w,44,C6140000040000000000000004000400000000000000)" },
  "LEFT|UP":     { action_id: "GS_LEFT_UP",     command_syntax: "(o2w,44,C6140000FC000000000000000400FC00000000000000)" },
  "RIGHT|DOWN":  { action_id: "GS_RIGHT_DOWN",  command_syntax: "(o2w,44,C6140000FC00000000000000FC000400000000000000)" },
  "RIGHT|FRONT": { action_id: "GS_RIGHT_FRONT", command_syntax: "(o2w,44,C61404000000000000000000FC000000040000000000)" },
  "RIGHT|BACK":  { action_id: "GS_RIGHT_BACK",  command_syntax: "(o2w,44,C614FC000000000000000000FC000000FC0000000000)" },
  "RIGHT|UP":    { action_id: "GS_RIGHT_UP",    command_syntax: "(o2w,44,C61400000400000000000000FC00FC00000000000000)" },
  "BACK|DOWN":   { action_id: "GS_BACK_DOWN",   command_syntax: "(o2w,44,C6140000000004000000FC0000000400000000000000)" },
  "BACK|UP":     { action_id: "GS_BACK_UP",     command_syntax: "(o2w,44,C614000000000400000004000000FC00000000000000)" },
  "BACK|RIGHT":  { action_id: "GS_BACK_RIGHT",  command_syntax: "(o2w,44,C6140000000004000400000000000000040000000000)" },
  "BACK|LEFT":   { action_id: "GS_BACK_LEFT",   command_syntax: "(o2w,44,C614000000000400FC00000000000000FC0000000000)" },
  "DOWN|FRONT":  { action_id: "GS_DOWN_FRONT",  command_syntax: "(o2w,44,C6140400000000000000FC00000000000000FC000000)" },
  "DOWN|BACK":   { action_id: "GS_DOWN_BACK",   command_syntax: "(o2w,44,C614FC000000000000000400000000000000FC000000)" },
  "DOWN|LEFT":   { action_id: "GS_DOWN_LEFT",   command_syntax: "(o2w,44,C6140000FC000000FC000000000000000000FC000000)" },
  "DOWN|RIGHT":  { action_id: "GS_DOWN_RIGHT",  command_syntax: "(o2w,44,C61400000400000004000000000000000000FC000000)" },
};

/**
 * getGsCommand — retorna o comando GS para a combinação label × harness.
 * Ambos os parâmetros são normalizados para UPPER_CASE antes da busca.
 * Retorna null se a combinação não estiver mapeada.
 */
export function getGsCommand(label: string, harness: string): GsCommand | null {
  const key = `${String(label).toUpperCase()}|${String(harness).toUpperCase()}`;
  return GS_COMMAND_MAP[key] ?? null;
}
