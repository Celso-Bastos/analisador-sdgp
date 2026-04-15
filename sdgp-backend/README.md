# Analisador SDGP — Back-end

Sistema de análise documental para regularização do Seguro Defeso (SDGP).

---

## Estrutura do projeto

```
sdgp-backend/
├── server.js                        # Ponto de entrada
├── package.json
├── .env.example                     # Modelo de variáveis de ambiente
├── .gitignore
├── public/
│   └── index.html                   # Front-end (pode servir estático ou hospedar separado)
└── src/
    ├── routes/
    │   └── api.js                   # Definição das rotas
    ├── controllers/
    │   └── analisarController.js    # Orquestra validação e serviço
    │   └── analisarController.js    # Orquestra o ocr do serviço
    ├── services/
    │   └── anthropicService.js      # Prompt e chamada à API da Anthropic
    └── validators/
        └── analisarValidator.js     # Validação e sanitização do payload
```

---

## Instalação local

### 1. Pré-requisitos
- Node.js 18 ou superior
- Conta na Anthropic com chave de API: https://console.anthropic.com

### 2. Instalar dependências
```bash
cd sdgp-backend
npm install
```

### 3. Configurar variáveis de ambiente
```bash
cp .env.example .env
```

Edite o `.env` e preencha:
```
ANTHROPIC_API_KEY=sk-ant-sua-chave-aqui
PORT=3000
ALLOWED_ORIGINS=http://localhost:5500
NODE_ENV=development
```

### 4. Rodar em desenvolvimento
```bash
npm run dev
```

### 5. Testar se está funcionando
```bash
curl http://localhost:3000/api/health
```
Resposta esperada:
```json
{ "ok": true, "status": "online" }
```

---

## Deploy em VPS (Ubuntu/Debian)

### 1. Instalar Node.js
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Clonar / enviar os arquivos para o servidor
```bash
# Opção A — via git
git clone https://github.com/seu-usuario/sdgp-backend.git
cd sdgp-backend

# Opção B — via scp (substitua pelo seu IP e caminho)
scp -r ./sdgp-backend usuario@SEU_IP:/home/usuario/sdgp-backend
```

### 3. Instalar dependências no servidor
```bash
cd sdgp-backend
npm install --production
```

### 4. Configurar o .env no servidor
```bash
cp .env.example .env
nano .env
# Preencha ANTHROPIC_API_KEY, ALLOWED_ORIGINS com seu domínio real, NODE_ENV=production
```

### 5. Rodar com PM2 (gerenciador de processos)
```bash
# Instalar PM2 globalmente
sudo npm install -g pm2

# Iniciar o servidor
pm2 start server.js --name sdgp-backend

# Salvar para reiniciar automaticamente após reboot
pm2 save
pm2 startup
```

### 6. Comandos úteis do PM2
```bash
pm2 status              # Ver status
pm2 logs sdgp-backend   # Ver logs em tempo real
pm2 restart sdgp-backend
pm2 stop sdgp-backend
```

### 7. Configurar Nginx como proxy reverso (recomendado)
```bash
sudo apt install nginx
sudo nano /etc/nginx/sites-available/sdgp
```

Cole a configuração:
```nginx
server {
    listen 80;
    server_name seudominio.com;

    location /api/ {
        proxy_pass http://localhost:3000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Se quiser servir o front-end pelo mesmo servidor
    location / {
        root /home/usuario/sdgp-backend/public;
        index index.html;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/sdgp /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 8. HTTPS com Let's Encrypt (recomendado em produção)
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d seudominio.com
```

---

## Endpoints da API

### GET /api/health
Verifica se o servidor está no ar.

**Resposta:**
```json
{
  "ok": true,
  "status": "online",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "versao": "1.0.0"
}
```

---

### POST /api/analisar
Analisa os documentos do pescador e retorna score e direcionamentos.

**Body (JSON):**
```json
{
  "nome": "João da Silva",
  "cpf": "123.456.789-00",
  "documentos": {
    "cnis": "Texto com dados do CNIS...",
    "rgp": "Texto com dados da Carteira de Pescador...",
    "reap": "Texto com dados do REAP 2021-2024...",
    "contribuicao": "Texto com dados do comprovante de contribuição...",
    "residencia": "Texto com dados do comprovante de residência..."
  }
}
```

**Resposta de sucesso:**
```json
{
  "ok": true,
  "resultado": {
    "score": 72,
    "resumo": "Situação parcialmente regular — pendências no REAP e contribuições.",
    "diretivas": [
      {
        "tipo": "ok",
        "titulo": "RGP válido",
        "texto": "Carteira de pescador ativa e dentro da validade, categoria artesanal confirmada."
      },
      {
        "tipo": "atencao",
        "titulo": "REAP incompleto",
        "texto": "O REAP apresenta registros apenas para 2022 e 2023. Verificar se há registro para 2021 e 2024."
      },
      {
        "tipo": "critico",
        "titulo": "Contribuições insuficientes",
        "texto": "Foram identificadas apenas 8 competências de contribuição nos últimos 12 meses. O mínimo exigido é 12."
      }
    ]
  }
}
```

**Resposta de erro:**
```json
{
  "ok": false,
  "erros": ["O campo 'nome' é obrigatório."]
}
```

---

## Rate limiting

| Rota | Limite |
|---|---|
| Todas as rotas | 30 req / 15 min por IP |
| POST /api/analisar | 5 req / 1 min por IP |

---

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `ANTHROPIC_API_KEY` | Sim | Chave da API Anthropic |
| `PORT` | Não | Porta do servidor (padrão: 3000) |
| `ALLOWED_ORIGINS` | Sim em produção | Domínios permitidos no CORS |
| `NODE_ENV` | Não | `development` ou `production` |
