.PHONY: build up down build-and-push deploy-ui deploy-backend deploy-sharing

# Variables
DOCKER_COMPOSE = docker-compose
GO = go
CURL = curl

# Colors for output
RED = \033[0;31m
GREEN = \033[0;32m
YELLOW = \033[1;33m
NC = \033[0m # No Color



build: ## Build all Docker images
	@echo "${YELLOW}Building Docker images...${NC}"
	@$(DOCKER_COMPOSE) build
	@echo "${GREEN}Build complete${NC}"

up: ## Start all services
	@echo "${YELLOW}Starting all services...${NC}"
	@$(DOCKER_COMPOSE) up -d
	@echo "${GREEN}Services started${NC}"

down: ## Stop all services
	@echo "${YELLOW}Stopping all services...${NC}"
	@$(DOCKER_COMPOSE) down
	@echo "${GREEN}Services stopped${NC}"

build-and-push: ## Build all and push images
	@docker build -t naturemyloves/file-browser-rclone-server:latest ./server
	@docker build -t naturemyloves/file-browser-rclone-ui:latest ./ui
	@docker push naturemyloves/file-browser-rclone-server:latest
	@docker push naturemyloves/file-browser-rclone-ui:latest

build-server:
	@docker build -t naturemyloves/file-browser-rclone-server:latest ./server
	@docker push naturemyloves/file-browser-rclone-server:latest

build-ui:
	@docker build -t naturemyloves/file-browser-rclone-ui:latest ./ui
	@docker push naturemyloves/file-browser-rclone-ui:latest

deploy-ui:
	@helm upgrade rclone-ui ./charts/ui -i --force

deploy-server:
	@helm upgrade rclone-server ./charts/server -i --force
