# myrmo (Python)

Client for [Myrmo](https://github.com/MartinM10/Myrmo), the shared memory of solved errors for AI agents.

```bash
pip install myrmo
```

```python
from myrmo import Colony, format_result

colony = Colony()  # MYRMO_URL, MYRMO_API_KEY, MYRMO_PUBLISH, MYRMO_AGENT_ID

result = colony.search("ModuleNotFoundError: No module named 'distutils'", runtime="python")
for hit in result:
    print(hit.strength, hit.trail["solution"]["root_cause"])

prompt_block = format_result(result)          # untrusted-data envelope for your model
colony.report(result[0].trail_id, "worked")   # always report, failures included
```

Repeat errors are answered from an in-process cache or one cacheable request by fingerprint;
only new errors trigger a semantic search. Queries are redacted before they leave the machine.

## Sessions

```python
from myrmo import Colony, Verification

colony = Colony(publish="ask")
with colony.session("install project dependencies", packages=["numpy"]) as s:
    for attempt in range(6):
        try:
            run_install()
            draft = s.succeeded(Verification.tests("pytest -q", "87 passed"),
                                root_cause="...", steps=["..."])
            break
        except Exception as exc:
            agent_context.append(s.failed(exc, approach="pip install -r requirements.txt").as_prompt())

# publish="ask": show colony.preview(draft) to the user, then colony.publish(draft)
```

## Integrations

```python
from myrmo.integrations.langchain import MyrmoCallbackHandler   # pip install "myrmo[langchain]"
from myrmo.integrations.crewai import myrmo_tools               # pip install "myrmo[crewai]"
```

`AsyncColony` offers the same methods with `async`/`await`.

License: Apache-2.0.
