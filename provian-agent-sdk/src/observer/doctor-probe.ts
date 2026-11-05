/**
 * The `provian doctor` pipeline probe : one definition, read by the doctor that
 * builds the synthetic OTel trace and by the OTel lane that must recognize it.
 *
 * WHY. Doctor proves the receiver → classifier path by posting a synthetic two-tool turn.
 * Until the OTel lane minted it like real work — an `agent_tool_orchestration` PE
 * sealed eligible at 1.6 PVT for a turn no agent ever ran (Atlas's 2026-08-27 doctor run
 * settled one). A fabricated turn is no act of work (PEs prove provenance), so the
 * lane classifies the probe — that is what doctor checks — and never submits it.
 *
 * A trace is the probe only when its orchestration span carries EXACTLY this name and its
 * tool spans EXACTLY these names; anything else is ordinary work. Mimicking the probe earns
 * nothing, which is the point.
 */
export const DOCTOR_PROBE_ORCHESTRATION_NAME = 'provian doctor synthetic turn';
export const DOCTOR_PROBE_TOOL_NAMES: readonly string[] = ['provian_doctor_probe_1', 'provian_doctor_probe_2'];
/** The daemon's log line for a recognized probe — doctor's classification evidence. */
export const DOCTOR_PROBE_LOG_LINE = 'otel doctor probe classified — never submitted';

export function isDoctorProbeTrace(orchestrationName: string | null | undefined, toolNames: readonly string[]): boolean {
  if (orchestrationName !== DOCTOR_PROBE_ORCHESTRATION_NAME) return false;
  if (toolNames.length !== DOCTOR_PROBE_TOOL_NAMES.length) return false;
  const want = [...DOCTOR_PROBE_TOOL_NAMES].sort();
  return [...toolNames].sort().every((n, i) => n === want[i]);
}
