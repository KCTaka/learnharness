import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { TeachingProfile } from "../../core/contracts/profile.ts";
import { renderProfileText } from "../../core/teaching-profile.ts";

/**
 * THE TEACHER'S PROFILE READER: how this learner is best taught, on demand.
 * Nothing is injected into the prompt (the same stance as the prober's graph
 * tools) — the teacher reads it when it plans and when it picks how to
 * present a step. Read-only: the profile is written by the learning pass
 * and the learner's own editor, never by the teacher.
 */

const input = Type.Object({});

export const READ_TEACHING_PROFILE_TOOL = "read_teaching_profile";

export function teachingProfileTool(readProfile: () => TeachingProfile): AgentTool<any> {
	return {
		name: READ_TEACHING_PROFILE_TOOL,
		label: READ_TEACHING_PROFILE_TOOL,
		description:
			"Read what has been learned about how THIS learner is best taught — their durable preferences for order, representation, step size, and kinds of check, some tagged with a subject. " +
			"Consult it when you plan and when you choose how to present a step. Entries are defaults, not rules: the learner's behavior in this session overrides them. Takes no input.",
		parameters: input,
		execute: serverExecute(READ_TEACHING_PROFILE_TOOL, input, async (): Promise<string> => {
			const text = renderProfileText(readProfile());
			return text === ""
				? "No teaching profile yet — nothing has been learned about how this learner is best taught. Teach by the session's own evidence."
				: `What has been learned about how this learner is best taught (subject in parentheses when specific):\n${text}`;
		}),
	};
}
