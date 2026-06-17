# Architecture — sample-app

## Stack

| Layer | Technology | Version |
|---|---|---|
| Language | Java | 21 |
| Framework | Spring Boot | 3.3 |
| Database | PostgreSQL | 16 |

## Runtime flow

```
client → Nginx → Spring app → JPA → Postgres
                            ↘ Redis (sessions)
                            ↘ Stripe (payments)
```

## Source code directories

| Path | Responsibility |
|---|---|
| `src/main/java/.../orders` | Order lifecycle + event sourcing |
| `src/main/java/.../payments` | Stripe + Pix integration |
