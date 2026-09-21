# @magic/dsh-ceo

CEO host plugin for DeepSeek Harness.

It adds CEO prompt rules and `ceo_delegate`. In CEO mode the session lead submits a `tasks[]` run graph. Independent nodes start together; a node with `depends_on` starts only after those producers finish. Workers are started through DSH `subagents.start` and the scheduler waits on each `result`. Using CEO does not create an engineering organization.
