up:
	@test -f .env || cp .env.example .env
	docker compose up -d --build
	@echo "frontend: http://localhost:3000   backend: http://localhost:8000"

down:
	docker compose down

logs:
	docker compose logs -f

test:
	cd backend && python -m pytest -q

.PHONY: up down logs test
