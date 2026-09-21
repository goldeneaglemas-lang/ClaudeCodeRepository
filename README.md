# ClaudeCodeRepository

## Birthday Reminder Agent

This repo includes a Claude Code subagent, `birthday-reminder`, defined in
[`.claude/agents/birthday-reminder.md`](.claude/agents/birthday-reminder.md).

It reads birthdays from `data/birthdays.json` (an array of `{ "name", "date" }`
entries, where `date` is `MM-DD`) and reports birthdays that are today or
coming up within the next 7 days. It can also add, update, or remove entries
when asked.

### Usage

Ask Claude things like:
- "Any birthdays coming up?"
- "Who has a birthday today?"
- "Add Ada Lovelace's birthday on December 10th."

Claude Code will route these to the `birthday-reminder` agent automatically.
