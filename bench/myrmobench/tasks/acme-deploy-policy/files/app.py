"""Billing service (Acme). Deployed with ./deploy.sh."""


def handler(event: dict) -> dict:
    return {"status": "ok", "invoice": event.get("invoice")}


if __name__ == "__main__":
    print(handler({"invoice": 42}))
