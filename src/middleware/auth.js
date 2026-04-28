// src/middleware/auth.js
// Autenticação via Google OAuth 2.0
// Fluxo:
//   1. Usuário acessa /api/auth/google → redirecionado para login Google
//   2. Google redireciona para /api/auth/google/callback com code
//   3. Servidor troca o code por token → verifica e-mail → cria sessão JWT
//   4. Frontend recebe JWT e envia em todo request via header Authorization

const jwt = require("jsonwebtoken");

// ── E-MAILS AUTORIZADOS ───────────────────────────────────────────────────────
// Adicionar ou remover e-mails no .env sem mexer no código:
// EMAILS_AUTORIZADOS=email1@gmail.com,email2@gmail.com
function getEmailsAutorizados() {
  const raw = process.env.EMAILS_AUTORIZADOS || "";
  return raw.split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
}

// ── GERAR URL DE LOGIN GOOGLE ─────────────────────────────────────────────────
function gerarUrlGoogle() {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope:         "openid email profile",
    access_type:   "online",
    prompt:        "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ── TROCAR CODE POR TOKEN GOOGLE ──────────────────────────────────────────────
async function trocarCodePorToken(code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
      grant_type:    "authorization_code",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Google token error: ${err.error_description || res.status}`);
  }
  return res.json();
}

// ── BUSCAR DADOS DO USUÁRIO GOOGLE ────────────────────────────────────────────
async function buscarUsuarioGoogle(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Erro ao buscar dados do usuário Google.");
  return res.json();
}

// ── GERAR JWT PRÓPRIO ─────────────────────────────────────────────────────────
function gerarJWT(usuario) {
  return jwt.sign(
    { email: usuario.email, nome: usuario.name, foto: usuario.picture },
    process.env.JWT_SECRET,
    { expiresIn: "8h" }  // sessão expira em 8 horas
  );
}

// ── MIDDLEWARE DE VERIFICAÇÃO JWT ─────────────────────────────────────────────
// Usado em todas as rotas protegidas
function verificarJWT(req, res, next) {
  // Rotas públicas — não exigem autenticação
  const rotasPublicas = ["/health", "/auth/google", "/auth/google/callback"];
  if (rotasPublicas.some(r => req.path.startsWith(r))) return next();

  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, erros: ["Não autenticado. Faça login para continuar."] });
  }

  const token = authHeader.split(" ")[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.usuario = payload;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ ok: false, erros: ["Sessão expirada. Faça login novamente."], expirado: true });
    }
    return res.status(401).json({ ok: false, erros: ["Token inválido."] });
  }
}

// ── HANDLERS DAS ROTAS DE AUTH ────────────────────────────────────────────────

// GET /api/auth/google → redireciona para login Google
function iniciarLogin(req, res) {
  res.redirect(gerarUrlGoogle());
}

// GET /api/auth/google/callback → recebe o code do Google
async function callbackGoogle(req, res) {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect("/?erro=login_cancelado");
  }

  try {
    // 1. Trocar code por access token
    const tokens = await trocarCodePorToken(code);

    // 2. Buscar dados do usuário
    const usuario = await buscarUsuarioGoogle(tokens.access_token);

    // 3. Verificar se e-mail está autorizado
    const autorizados = getEmailsAutorizados();
    if (!autorizados.includes(usuario.email.toLowerCase())) {
      console.warn(`[AUTH] Tentativa de acesso não autorizado: ${usuario.email}`);
      return res.redirect("/?erro=acesso_negado");
    }

    // 4. Gerar JWT próprio
    const jwtToken = gerarJWT(usuario);

    console.log(`[AUTH] Login bem-sucedido: ${usuario.email}`);

    // 5. Redirecionar para o frontend com o token na URL
    // O frontend vai capturar o token e armazenar em memória
    res.redirect(`/?token=${encodeURIComponent(jwtToken)}`);

  } catch (err) {
    console.error("[AUTH] Erro no callback:", err.message);
    res.redirect("/?erro=erro_interno");
  }
}

module.exports = { verificarJWT, iniciarLogin, callbackGoogle };