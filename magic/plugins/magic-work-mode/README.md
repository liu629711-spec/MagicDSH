# @magic/dsh-work-mode

Magic agent / CEO work-mode plugin for DeepSeek Harness.

It contributes a system-prompt section, a `/mode` command, and a composer-left control.

- Session default is agent.
- `/mode ceo` changes the session default.
- `/mode once ceo` applies only to the current input; after that user message is sent, the session default returns.
- Using CEO does not create an engineering organization.
