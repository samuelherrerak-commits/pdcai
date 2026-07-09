document.addEventListener('DOMContentLoaded', () => {

    // =========================================================
    // MÓDULO 1: CONFIGURACIÓN SUPABASE Y ESTADO EN MEMORIA
    // =========================================================
    lucide.createIcons();

    const SUPABASE_URL = window.SUPABASE_URL || (() => { throw new Error('Config.js no cargado. Verifica que Config.js existe.'); })();
    const SUPABASE_KEY = window.SUPABASE_KEY || (() => { throw new Error('Config.js no cargado. Verifica que Config.js existe.'); })();
    const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    // Estado global
    let facturasGlobal     = {};   // { rif: { numFactura: { abiertoUSD, ivaBs, fechaVencimiento, esAjuste, abiertoUSDOriginal, granTotalVES } } }
    let pagosGlobal        = [];
    let currentUser        = null; // { id, role }
    let selectedTotal      = 0;
    let desglosePagadoGlobal = [];
    let selectedIVATotal   = 0;
    let desgloseIVAGlobal  = [];


    // =========================================================
    // MÓDULO 2: CONTROLADORES DE INTERFAZ, LOADER Y VISTAS
    // =========================================================
    const views = {
        login:    document.getElementById('login-section'),
        admin:    document.getElementById('admin-panel'),
        client:   document.getElementById('client-panel'),
        success:  document.getElementById('success-section')
    };

    window.showView = function(viewName) {
        Object.values(views).forEach(v => { if (v) v.classList.add('hidden'); });
        if (views[viewName]) views[viewName].classList.remove('hidden');
    };

    function showLoader(message = "PROCESANDO...") {
        const textEl = document.getElementById('loader-text');
        if (textEl) textEl.textContent = message;
        const loader = document.getElementById('global-loader');
        loader.style.display = 'flex';
        loader.classList.remove('hidden');
    }

    function hideLoader() {
        const loader = document.getElementById('global-loader');
        loader.classList.add('hidden');
        loader.style.display = 'none';
    }

    window.switchAdminTab = function(tabName) {
        document.querySelectorAll('.admin-tab-content').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.tab-admin').forEach(el => el.classList.remove('active'));
        document.getElementById('admin-tab-' + tabName).classList.remove('hidden');
        if (event) event.currentTarget.classList.add('active');
    };

    const tabIdMap = { 'estado-cuenta': 'estado', historial: 'historial', iva: 'iva', retenciones: 'retenciones' };
    window.switchClientTab = function(tabName) {
        document.querySelectorAll('.client-tab-content').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.tab-client').forEach(el => el.classList.remove('active'));
        const id = tabIdMap[tabName] || tabName;
        const el = document.getElementById('client-tab-' + id);
        if (el) el.classList.remove('hidden');
        if (event && event.currentTarget) event.currentTarget.classList.add('active');
        if (tabName === 'historial') loadClientHistory();
        if (tabName === 'iva')       loadClientIVA();
        if (tabName === 'retenciones') loadClientRetenciones();
    };

    window.toggleAccordion = function(id) {
        const content = document.getElementById(id);
        const icon    = document.getElementById('icon-' + id);
        content.classList.toggle('hidden');
        if (icon) {
            icon.innerHTML = content.classList.contains('hidden')
                ? '<i data-lucide="chevron-down"></i>'
                : '<i data-lucide="chevron-up"></i>';
            lucide.createIcons();
        }
    };

    // Modal de soporte: maneja display + hidden para garantizar visibilidad
    window.abrirModalSoporte = function(urlOrBase64) {
        if (!urlOrBase64 || urlOrBase64 === 'null' || urlOrBase64 === 'undefined') {
            alert('No hay soporte adjunto para este pago.'); return;
        }
        const modal = document.getElementById('modal-soporte');
        const img   = document.getElementById('img-soporte');
        img.src = '';           // limpiar primero para forzar recarga
        img.src = urlOrBase64;
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    };

    function cerrarModalSoporte() {
        const modal = document.getElementById('modal-soporte');
        modal.classList.add('hidden');
        modal.style.display = 'none';
        document.getElementById('img-soporte').src = '';
    }
    window.cerrarModalSoporte = cerrarModalSoporte;

    const closeModalBtn = document.getElementById('close-modal-soporte');
    if (closeModalBtn) closeModalBtn.addEventListener('click', cerrarModalSoporte);

    // Cerrar también haciendo click fuera de la imagen
    const modalEl = document.getElementById('modal-soporte');
    if (modalEl) modalEl.addEventListener('click', function(e) {
        if (e.target === this) cerrarModalSoporte();
    });

    function parseFlexibleDate(dateStr) {
        if (!dateStr) return new Date();
        dateStr = String(dateStr).trim();
        if (dateStr.includes('-')) {
            const parts = dateStr.split('-');
            return parts[0].length === 4
                ? new Date(parts[0], parts[1] - 1, parts[2])
                : new Date(parts[2], parts[1] - 1, parts[0]);
        }
        if (dateStr.includes('/')) {
            const parts = dateStr.split('/');
            return parts[0].length === 4
                ? new Date(parts[0], parts[1] - 1, parts[2])
                : new Date(parts[2], parts[1] - 1, parts[0]);
        }
        const standard = new Date(dateStr);
        return isNaN(standard.getTime()) ? new Date() : standard;
    }


    // =========================================================
    // MÓDULO 3: SYNC DE DATOS DESDE SUPABASE
    //   - Tabla: facturas_saldos
    //   - Tabla: pagos
    // =========================================================
    async function syncDataFromCloud() {
        facturasGlobal = {};

        // --- FACTURAS (facturas_saldos) ---
        let query = supabase.from('facturas_saldos').select('*').gt('abierto_usd', 0);
        if (currentUser.role === 'cliente') {
            query = query.eq('rif_cliente', currentUser.id);
        } else {
            query = query.limit(2000);
        }

        const { data: dbFacturas, error: errFact } = await query;
        if (errFact) throw errFact;

        (dbFacturas || []).forEach(row => {
            const rif     = row.rif_cliente;
            const factura = row.num_factura;
            if (!facturasGlobal[rif]) facturasGlobal[rif] = {};
            facturasGlobal[rif][factura] = {
                abiertoUSD:         parseFloat(row.abierto_usd) || 0,
                ivaBs:              parseFloat(row.iva_bs) || 0,
                fechaVencimiento:   row.fecha_vencimiento || '',
                esAjuste:           !!row.es_ajuste,
                abiertoUSDOriginal: parseFloat(row.abierto_usd_original) || 0,
                granTotalVES:       parseFloat(row.gran_total_ves) || 0
            };
        });

        // --- PAGOS ---
        let queryPagos = supabase.from('pagos').select('*').order('created_at', { ascending: false });
        if (currentUser.role === 'cliente') {
            queryPagos = queryPagos.eq('rif_cliente', currentUser.id);
        } else {
            queryPagos = queryPagos.limit(2000);
        }

        const { data: dbPagos, error: errPagos } = await queryPagos;
        if (errPagos) throw errPagos;

        pagosGlobal = (dbPagos || []).map(p => ({
            id:              p.id,
            rif:             p.rif_cliente,
            factura:         p.num_factura,
            tipo:            p.tipo_pago || 'base',
            concepto:        p.concepto,
            montoPagado:     parseFloat(p.monto_pagado) || 0,
            metodo:          p.metodo,
            referencia:      p.referencia,
            fechaPago:       p.fecha_pago,
            status:          p.status,
            soporte_url:     p.soporte_url,
            desglosePagado:  p.desglose_pagado || [],
            procesadoPor:    p.procesado_por || '',
            fechaProcesado:  p.fecha_procesado || '',
            observacion:     p.observacion_admin || ''
        }));
    }


    // =========================================================
    // MÓDULO 4: AUTENTICACIÓN (SUPABASE)
    // =========================================================
    // --- LOGIN ---
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const user     = document.getElementById('login-username').value.trim().toUpperCase();
        const pass     = document.getElementById('login-password').value;
        const errorMsg = document.getElementById('login-error');

        if (!user || !pass) return;
        errorMsg.classList.add('hidden');
        showLoader('VALIDANDO CREDENCIALES...');

        try {
            const { data: usuario, error } = await supabase
                .from('usuarios')
                .select('*')
                .eq('rif', user)
                .eq('password', pass)
                .maybeSingle();

            if (error || !usuario) {
                throw new Error("Credenciales inválidas o incorrectas.");
            }

            if (usuario.rol === 'cliente' && !usuario.aprobado) {
                throw new Error("Tu usuario está en espera de aprobación por el administrador.");
            }

            currentUser = {
                id:                usuario.rif,
                role:              usuario.rol,
                esAgenteRetencion: !!usuario.es_agente_retencion
            };

            showLoader('SINCRONIZANDO BASE DE DATOS...');
            await syncDataFromCloud();

            document.getElementById('nav-status').textContent =
                currentUser.role === 'administrador' ? 'Administrador' : 'Cliente';
            document.getElementById('btn-logout').classList.remove('hidden');

            // Mostrar/ocultar botón Comprobantes Retención según rol
            const btnRet = document.getElementById('btn-tab-retenciones');
            if (btnRet) {
                btnRet.classList.toggle('hidden', !(currentUser.esAgenteRetencion));
            }

            if (currentUser.role === 'administrador') {
                loadDashboardStats();
                renderAdminPayments();
                renderAdminUsers();
                showView('admin');
                setTimeout(() => window.iniciarTour?.('admin'), 400);
            } else {
                loadClientInvoices();
                showView('client');
                setTimeout(() => window.iniciarTour?.('cliente'), 400);
            }
        } catch (err) {
            errorMsg.textContent = err.message;
            errorMsg.classList.remove('hidden');
        } finally { hideLoader(); }
    });

    // --- LOGOUT ---
    document.getElementById('btn-logout').addEventListener('click', () => {
        currentUser          = null;
        facturasGlobal       = {};
        pagosGlobal          = [];
        selectedTotal        = 0;
        desglosePagadoGlobal = [];
        selectedIVATotal     = 0;
        desgloseIVAGlobal    = [];
        document.getElementById('login-form').reset();
        document.getElementById('nav-status').textContent = 'Portal de Cobranzas';
        document.getElementById('btn-logout').classList.add('hidden');
        showView('login');
    });


    // =========================================================
    // MÓDULO 5 & 6: PANEL ADMINISTRADOR — DASHBOARD COMPLETO
    // =========================================================

    // ── Variables de estado del admin ────────────────────────
    let adminCharts       = {};   // instancias Chart.js para destruir/recrear
    let filtrosPagos      = { rif: '', factura: '', status: '', metodo: '' };

    // ── Helper: formatear moneda ──────────────────────────────
    function fmt(n) {
        return '$' + Number(n || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // ── Helper: días entre dos fechas (negativo = futuro) ────
    function diasDesde(dateStr) {
        if (!dateStr) return null;
        const hoy = new Date(); hoy.setHours(0,0,0,0);
        const d   = parseFlexibleDate(dateStr); d.setHours(0,0,0,0);
        return Math.ceil((hoy - d) / 86400000);
    }

    function calcAdminStats() {
        const hoy   = new Date(); hoy.setHours(0,0,0,0);
        const mesH  = hoy.getMonth();
        const anyoH = hoy.getFullYear();

        let carteraPendiente = 0;
        let facturasPend     = 0;
        let facturasVenc     = 0;
        let cobradoMes       = 0;
        let pagosPendRev     = 0;

        let gPendiente = 0, gVencido = 0;
        const deudaPorCliente = {};
        const cobMensual = {};
        for (let i = 5; i >= 0; i--) {
            const d = new Date(anyoH, mesH - i, 1);
            const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
            cobMensual[k] = 0;
        }

        for (const rif in facturasGlobal) {
            let deudaCliente = 0;
            for (const factura in facturasGlobal[rif]) {
                const f = facturasGlobal[rif][factura];
                const saldo = f.abiertoUSD;
                if (saldo <= 0) continue;

                facturasPend++;
                carteraPendiente += saldo;
                deudaCliente += saldo;

                const fv = f.fechaVencimiento;
                if (fv) {
                    const dias = diasDesde(fv);
                    if (dias > 0) { facturasVenc++; gVencido += saldo; }
                    else          { gPendiente += saldo; }
                } else { gPendiente += saldo; }
            }
            if (deudaCliente > 0) deudaPorCliente[rif] = deudaCliente;
        }

        pagosGlobal.forEach(p => {
            if (p.status === 'Pendiente') pagosPendRev++;
            if (p.status === 'Aprobado') {
                const fp = p.fechaPago ? new Date(p.fechaPago + 'T00:00:00') : null;
                if (fp) {
                    const k = `${fp.getFullYear()}-${String(fp.getMonth()+1).padStart(2,'0')}`;
                    if (cobMensual[k] !== undefined) cobMensual[k] += p.montoPagado;
                    if (fp.getMonth() === mesH && fp.getFullYear() === anyoH) cobradoMes += p.montoPagado;
                }
            }
        });

        const top5 = Object.entries(deudaPorCliente)
            .sort((a,b) => b[1] - a[1]).slice(0, 5);

        return {
            carteraPendiente, facturasPend, facturasVenc,
            cobradoMes, pagosPendRev,
            gPendiente, gVencido,
            cobMensual, top5
        };
    }

    // ── FUNCIÓN: loadDashboardStats() ────────────────────────
    function loadDashboardStats() {
        const s = calcAdminStats();
        // KPI cards
        set('kpi-cartera',    fmt(s.carteraPendiente));
        set('kpi-facturas',   s.facturasPend);
        set('kpi-vencidas',   s.facturasVenc);
        set('kpi-rev',        s.pagosPendRev);
        set('kpi-cobrado',    fmt(s.cobradoMes));
        // Resumen secundario
        set('summary-clientes',    Object.keys(facturasGlobal).length);
        set('summary-monto',       fmt(s.carteraPendiente));
        set('summary-recaudacion', fmt(pagosGlobal.filter(p=>p.status==='Aprobado').reduce((a,p)=>a+p.montoPagado,0)));
        // Aging
        let aging = { vigente: 0, d30: 0, d60: 0 };
        for (const rif in facturasGlobal) {
            for (const factura in facturasGlobal[rif]) {
                const f = facturasGlobal[rif][factura];
                const saldo = f.abiertoUSD;
                if (saldo <= 0) continue;
                const fv = f.fechaVencimiento;
                const dias = diasDesde(fv);
                if (!fv || dias === null || dias <= 0) aging.vigente += saldo;
                else if (dias <= 30)                  aging.d30     += saldo;
                else                                  aging.d60     += saldo;
            }
        }
        set('aging-0',  fmt(aging.vigente));
        set('aging-30', fmt(aging.d30));
        set('aging-60', fmt(aging.d60));
        // Badge de alertas
        set('badge-venc', s.facturasVenc > 0 ? s.facturasVenc : '');

        generateCharts(s);
    }
    // alias para compatibilidad con el nombre anterior
    function updateAdminDashboards() { loadDashboardStats(); }

    function set(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    // ── FUNCIÓN: generateCharts(stats) ───────────────────────
    function generateCharts(s) {
        // Destruir gráficos previos si existen
        Object.values(adminCharts).forEach(c => { try { c.destroy(); } catch(e){} });
        adminCharts = {};

        const fontColor = 'rgba(255,255,255,0.7)';
        const gridColor = 'rgba(255,255,255,0.07)';

        // ── GRÁFICO 1: Dona — Estado cartera ──
        const c1 = document.getElementById('chart-dona');
        if (c1) {
            adminCharts.dona = new Chart(c1, {
                type: 'doughnut',
                data: {
                    labels: ['Pendiente', 'Vencido'],
                    datasets: [{ data: [s.gPendiente, s.gVencido],
                        backgroundColor: ['#3b82f6','#ef4444'],
                        borderColor: 'rgba(0,0,0,0.3)', borderWidth: 2 }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, cutout: '68%',
                    plugins: {
                        legend: { labels: { color: fontColor, font: { size: 12 } } },
                        tooltip: { callbacks: { label: ctx => ' ' + fmt(ctx.parsed) } }
                    }
                }
            });
        }

        // ── GRÁFICO 2: Barras — Cobranza mensual ──
        const c2 = document.getElementById('chart-barras');
        if (c2) {
            const labels = Object.keys(s.cobMensual).map(k => {
                const [y,m] = k.split('-');
                return ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][parseInt(m)-1] + ' ' + y.slice(2);
            });
            adminCharts.barras = new Chart(c2, {
                type: 'bar',
                data: {
                    labels,
                    datasets: [{ label: 'Cobrado', data: Object.values(s.cobMensual),
                        backgroundColor: 'rgba(34,197,94,0.7)', borderColor: '#22c55e',
                        borderWidth: 1, borderRadius: 6 }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: { callbacks: { label: ctx => ' ' + fmt(ctx.parsed.y) } }
                    },
                    scales: {
                        x: { ticks: { color: fontColor }, grid: { color: gridColor } },
                        y: { ticks: { color: fontColor, callback: v => fmt(v) }, grid: { color: gridColor } }
                    }
                }
            });
        }

        // ── GRÁFICO 3: Barras horizontales — Top 5 deudores ──
        const c3 = document.getElementById('chart-top5');
        if (c3) {
            adminCharts.top5 = new Chart(c3, {
                type: 'bar',
                data: {
                    labels: s.top5.map(([rif]) => rif),
                    datasets: [{ label: 'Deuda', data: s.top5.map(([,v]) => v),
                        backgroundColor: 'rgba(234,179,8,0.7)', borderColor: '#eab308',
                        borderWidth: 1, borderRadius: 6 }]
                },
                options: {
                    indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: { callbacks: { label: ctx => ' ' + fmt(ctx.parsed.x) } }
                    },
                    scales: {
                        x: { ticks: { color: fontColor, callback: v => fmt(v) }, grid: { color: gridColor } },
                        y: { ticks: { color: fontColor, font: { family: 'monospace', size: 11 } }, grid: { display: false } }
                    }
                }
            });
        }
    }

    // ── FUNCIÓN: loadAlerts() ─────────────────────────────────
    function loadAlerts() {
        const hoy = new Date(); hoy.setHours(0,0,0,0);

        const vencidas = [], proximas = [], parciales = [];

        for (const rif in facturasGlobal) {
            for (const [numFac, datos] of Object.entries(facturasGlobal[rif])) {
                const saldo = datos.abiertoUSD;
                if (saldo <= 0) continue;

                const fv   = datos.fechaVencimiento;
                const dias = diasDesde(fv);

                if (fv && dias > 0) {
                    vencidas.push({ rif, numFac, saldo, dias, fv });
                } else if (fv && dias !== null && dias >= -7 && dias <= 0) {
                    proximas.push({ rif, numFac, saldo, dias: Math.abs(dias), fv });
                }

                const pagosAprobados = pagosGlobal.filter(
                    p => p.rif === rif && p.factura && p.factura.includes(numFac) && p.status === 'Aprobado'
                );
                if (pagosAprobados.length > 0) {
                    const abonado = pagosAprobados.reduce((a,p) => a+p.montoPagado, 0);
                    const baseOriginal = saldo + abonado;
                    if (abonado > 0 && saldo > 0) {
                        parciales.push({ rif, numFac, baseOriginal, abonado, saldo });
                    }
                }
            }
        }

        // Render vencidas
        const tvenc = document.getElementById('alerts-vencidas-tbody');
        if (tvenc) {
            tvenc.innerHTML = vencidas.length === 0
                ? '<tr><td colspan="4" style="text-align:center;color:rgba(255,255,255,0.3);padding:12px;">Sin facturas vencidas ✓</td></tr>'
                : vencidas.sort((a,b)=>b.dias-a.dias).map(r => `
                    <tr>
                        <td style="font-family:monospace;">${r.rif}</td>
                        <td>${r.numFac}</td>
                        <td class="font-serif" style="color:#ef4444;">${fmt(r.saldo)}</td>
                        <td><span style="background:#ef444420;color:#ef4444;padding:3px 8px;border-radius:10px;font-size:12px;border:1px solid #ef444440;">${r.dias} días</span></td>
                    </tr>`).join('');
        }

        // Render próximas a vencer
        const tprox = document.getElementById('alerts-proximas-tbody');
        if (tprox) {
            tprox.innerHTML = proximas.length === 0
                ? '<tr><td colspan="4" style="text-align:center;color:rgba(255,255,255,0.3);padding:12px;">Sin facturas próximas a vencer ✓</td></tr>'
                : proximas.sort((a,b)=>a.dias-b.dias).map(r => `
                    <tr>
                        <td style="font-family:monospace;">${r.rif}</td>
                        <td>${r.numFac}</td>
                        <td style="color:rgba(255,255,255,0.7);">${r.fv}</td>
                        <td class="font-serif" style="color:#eab308;">${fmt(r.saldo)}</td>
                    </tr>`).join('');
        }

        // Render parciales
        const tparc = document.getElementById('alerts-parciales-tbody');
        if (tparc) {
            tparc.innerHTML = parciales.length === 0
                ? '<tr><td colspan="4" style="text-align:center;color:rgba(255,255,255,0.3);padding:12px;">Sin pagos parciales activos ✓</td></tr>'
                : parciales.map(r => `
                    <tr>
                        <td style="font-family:monospace;">${r.rif}</td>
                        <td>${r.numFac}</td>
                        <td class="font-serif" style="color:#22c55e;">${fmt(r.abonado)}</td>
                        <td class="font-serif" style="color:#eab308;">${fmt(r.saldo)}</td>
                    </tr>`).join('');
        }

        // Badges en el tab
        set('badge-venc',  vencidas.length  || '');
        set('badge-prox',  proximas.length  || '');
        set('badge-parc',  parciales.length || '');
    }

    // ── FUNCIÓN: searchClients(rif) ──────────────────────────
    window.searchClients = async function() {
        const q    = (document.getElementById('search-rif-input')?.value || '').trim().toUpperCase();
        const wrap = document.getElementById('client-profile-wrap');
        if (!q || !wrap) return;

        showLoader('BUSCANDO CLIENTE...');
        try {
            const { data: u, error: eu } = await supabase
                .from('usuarios').select('*').eq('rif', q).maybeSingle();
            if (eu || !u) throw new Error('No se encontró el cliente con RIF: ' + q);

            const { data: facs } = await supabase
                .from('facturas_saldos').select('*').eq('rif_cliente', q).limit(500);

            const { data: pags } = await supabase
                .from('pagos').select('*').eq('rif_cliente', q).order('created_at', { ascending: false }).limit(200);

            let totalDeuda = 0;
            const facturasMap = {};
            (facs || []).forEach(f => {
                const saldo = parseFloat(f.abierto_usd) || 0;
                totalDeuda += saldo;
                if (!facturasMap[f.num_factura]) {
                    facturasMap[f.num_factura] = {
                        saldo: 0, fv: f.fecha_vencimiento,
                        esAjuste: !!f.es_ajuste
                    };
                }
                facturasMap[f.num_factura].saldo += saldo;
            });

            const ultimoPago = pags && pags.length > 0 ? pags[0] : null;

            // Render ficha cliente
            const filasFacturas = Object.entries(facturasMap).map(([nf, d]) => {
                const dias   = diasDesde(d.fv);
                const estado = !d.fv ? 'Sin fecha'
                    : dias > 0  ? `<span style="color:#ef4444;">Vencida ${dias}d</span>`
                    : dias > -8 ? `<span style="color:#eab308;">Vence en ${Math.abs(dias)}d</span>`
                    : `<span style="color:#22c55e;">Vigente</span>`;
                return `<tr>
                    <td>${nf}</td>
                    <td>${d.fv || '-'}</td>
                    <td class="font-serif">${fmt(d.saldo)}</td>
                    <td>${estado}</td>
                </tr>`;
            }).join('');

            wrap.innerHTML = `
                <div class="card liquid-glass" style="margin-bottom:15px;border-color:#3b82f6;">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:15px;">
                        <div>
                            <h3 style="margin:0 0 5px;font-size:20px;font-family:monospace;color:#3b82f6;">${u.rif}</h3>
                            <p style="margin:0 0 4px;font-size:13px;">${perfilFiscal}</p>
                            <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.5);">
                                Estado: <span style="color:${u.aprobado?'#22c55e':'#ef4444'}">${u.aprobado?'Activo':'Pendiente aprobación'}</span>
                            </p>
                        </div>
                        <div style="display:flex;gap:15px;flex-wrap:wrap;">
                            <div style="text-align:center;padding:10px 20px;background:rgba(239,68,68,0.1);border:1px solid #ef444440;border-radius:10px;">
                                <span style="font-size:11px;color:rgba(255,255,255,0.5);display:block;">DEUDA TOTAL USD</span>
                                <span class="font-serif" style="font-size:22px;color:#ef4444;">${fmt(totalDeuda)}</span>
                            </div>
                            <div style="text-align:center;padding:10px 20px;background:rgba(34,197,94,0.1);border:1px solid #22c55e40;border-radius:10px;">
                                <span style="font-size:11px;color:rgba(255,255,255,0.5);display:block;">FACTURAS PEND.</span>
                                <span class="font-serif" style="font-size:22px;color:#22c55e;">${Object.keys(facturasMap).length}</span>
                            </div>
                            <div style="text-align:center;padding:10px 20px;background:rgba(59,130,246,0.1);border:1px solid #3b82f640;border-radius:10px;">
                                <span style="font-size:11px;color:rgba(255,255,255,0.5);display:block;">ÚLTIMO PAGO</span>
                                <span style="font-size:13px;color:#3b82f6;">${ultimoPago ? ultimoPago.fecha_pago + '<br><small>' + ultimoPago.status + '</small>' : 'Sin pagos'}</span>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="card liquid-glass">
                    <h4 style="margin:0 0 12px;font-size:14px;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:1px;">Facturas del cliente</h4>
                    <div class="table-container">
                        <table>
                            <thead><tr><th>Factura</th><th>Vencimiento</th><th>Saldo</th><th>Estado</th></tr></thead>
                            <tbody>${filasFacturas || '<tr><td colspan="4" style="text-align:center;color:rgba(255,255,255,0.3);">Sin deudas pendientes</td></tr>'}</tbody>
                        </table>
                    </div>
                </div>`;
        } catch(err) {
            wrap.innerHTML = `<div class="card liquid-glass" style="border-color:#ef4444;text-align:center;padding:30px;">
                <i data-lucide="search-x" style="width:40px;height:40px;color:#ef4444;margin:0 auto 10px;"></i>
                <p style="color:#ef4444;margin:0;">${err.message}</p>
            </div>`;
            lucide.createIcons();
        } finally { hideLoader(); }
    };

    // Buscar con Enter
    document.getElementById('search-rif-input')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') window.searchClients();
    });

    // ── FUNCIÓN: renderAdminUsers() (primera versión) ─────────
    async function renderAdminUsers() {
        const tbody = document.getElementById('admin-users-tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        const { data: usuarios, error } = await supabase
            .from('usuarios').select('*').eq('rol', 'cliente').order('created_at', { ascending: false });

        if (error || !usuarios || usuarios.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:rgba(255,255,255,0.4);padding:20px;">No hay clientes registrados.</td></tr>';
            return;
        }

        usuarios.forEach(u => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="font-family:monospace;color:#3b82f6;">${u.rif}</td>
                <td>${u.nombre_empresa || '<span style="color:rgba(255,255,255,0.3);">-</span>'}</td>
                <td style="font-size:12px;">${u.email || '-'}</td>
                <td style="font-size:12px;">${u.telefono || '-'}</td>
                <td><span style="color:${u.aprobado?'#22c55e':'#ef4444'}">${u.aprobado?'Activo':'Pendiente'}</span></td>
                <td>
                    ${!u.aprobado
                        ? `<button class="btn-solid" style="padding:4px 10px;font-size:12px;background:#22c55e;color:black;" onclick="aprobarUsuarioNube('${u.rif}')">Aprobar</button>`
                        : `<span style="font-size:12px;color:rgba(255,255,255,0.3)">Verificado</span>`}
                </td>`;
            tbody.appendChild(tr);
        });
    }

    window.aprobarUsuarioNube = async function(rif) {
        showLoader('APROBANDO USUARIO...');
        await supabase.from('usuarios').update({ aprobado: true }).eq('rif', rif);
        await renderAdminUsers();
        hideLoader();
    };

    // ── FUNCIÓN: filterPayments() ─────────────────────────────
    // Aplica los filtros del módulo de pagos y re-renderiza la tabla
    window.filterPayments = function() {
        filtrosPagos.rif     = (document.getElementById('filtro-rif')?.value     || '').trim().toUpperCase();
        filtrosPagos.factura = (document.getElementById('filtro-factura')?.value || '').trim();
        filtrosPagos.status  = document.getElementById('filtro-status')?.value   || '';
        filtrosPagos.metodo  = document.getElementById('filtro-metodo')?.value   || '';
        filtrosPagos.fecha   = document.getElementById('filtro-fecha')?.value    || '';
        renderAdminPayments();
    };

    window.clearPaymentFilters = function() {
        ['filtro-rif','filtro-factura','filtro-status','filtro-metodo','filtro-fecha'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        filtrosPagos = { rif: '', factura: '', status: '', metodo: '', fecha: '' };
        renderAdminPayments();
    };

    // ── FUNCIÓN: renderAdminPayments() ───────────────────────
    function renderAdminPayments() {
        const tbody = document.getElementById('admin-payments-tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        // Aplicar filtros
        let lista = pagosGlobal;
        if (filtrosPagos.rif)     lista = lista.filter(p => p.rif.includes(filtrosPagos.rif));
        if (filtrosPagos.factura) lista = lista.filter(p => (p.factura||'').includes(filtrosPagos.factura));
        if (filtrosPagos.status)  lista = lista.filter(p => p.status === filtrosPagos.status);
        if (filtrosPagos.metodo)  lista = lista.filter(p => p.metodo === filtrosPagos.metodo);
        if (filtrosPagos.fecha)   lista = lista.filter(p => p.fechaPago === filtrosPagos.fecha);

        if (lista.length === 0) {
            tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:rgba(255,255,255,0.4);padding:20px;">No hay pagos que coincidan con los filtros.</td></tr>';
            return;
        }

        lista.forEach(pago => {
            const col = pago.status === 'Aprobado' ? '#22c55e'
                      : pago.status === 'Rechazado' ? '#ef4444' : '#eab308';
            const tipoLabel = pago.tipo === 'iva' ? 'IVA Bs' : 'USD';
            const tipoColor = pago.tipo === 'iva' ? '#c084fc' : '#3b82f6';

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="font-family:monospace;font-size:12px;">${pago.rif}</td>
                <td>${pago.factura || '-'}</td>
                <td><span style="background:${tipoColor}20;color:${tipoColor};padding:2px 6px;border-radius:8px;font-size:11px;">${tipoLabel}</span></td>
                <td>${pago.concepto || '-'}</td>
                <td class="font-serif" style="font-size:16px;">${fmt(pago.montoPagado)}</td>
                <td>${pago.metodo}</td>
                <td style="font-family:monospace;font-size:12px;">${pago.referencia}</td>
                <td>${pago.fechaPago}</td>
                <td><span style="background:${col}20;color:${col};padding:3px 8px;border-radius:10px;font-size:11px;border:1px solid ${col}40;">${pago.status}</span></td>
                <td style="font-size:12px;color:${pago.procesadoPor ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.25)'};">${pago.procesadoPor || '-'}</td>
                <td style="font-size:12px;color:rgba(255,255,255,0.5);">${pago.fechaProcesado ? new Date(pago.fechaProcesado).toLocaleDateString() : '-'}</td>
            `;

            // Celda acciones — construida con DOM para evitar problemas de escape
            const tdAcc = document.createElement('td');
            tdAcc.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;align-items:center;';

            if (pago.soporte_url) {
                const b = document.createElement('button');
                b.className = 'btn-outline'; b.style.cssText = 'padding:4px 8px;font-size:11px;';
                b.textContent = '🖼 Soporte';
                b.addEventListener('click', () => abrirModalSoporte(pago.soporte_url));
                tdAcc.appendChild(b);
            } else {
                const sp = document.createElement('span');
                sp.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.25);';
                sp.textContent = 'Sin soporte';
                tdAcc.appendChild(sp);
            }
            if (pago.status === 'Pendiente') {
                const bA = document.createElement('button');
                bA.className = 'btn-solid';
                bA.style.cssText = 'padding:4px 8px;font-size:11px;background:#22c55e;color:black;';
                bA.textContent = '✓ Aprobar';
                bA.addEventListener('click', () => procesarPagoNube(pago.id, 'Aprobado'));

                const bR = document.createElement('button');
                bR.className = 'btn-solid';
                bR.style.cssText = 'padding:4px 8px;font-size:11px;background:#ef4444;color:black;';
                bR.textContent = '✕ Rechazar';
                bR.addEventListener('click', () => procesarPagoNube(pago.id, 'Rechazado'));

                tdAcc.appendChild(bA);
                tdAcc.appendChild(bR);
            }
            tr.appendChild(tdAcc);
            tbody.appendChild(tr);
        });
    }

    // ── Aprobar / Rechazar pago ───────────────────────────────
    window.procesarPagoNube = async function(idTransaccion, nuevoEstado) {
        if (nuevoEstado === 'Rechazado' && !confirm('¿Desea rechazar esta transacción?')) return;
        const observacion = nuevoEstado === 'Rechazado'
            ? (prompt('Motivo del rechazo (opcional):', '') || '')
            : '';
        showLoader(`PROCESANDO (${nuevoEstado.toUpperCase()})...`);
        try {
            const { data, error } = await supabase.rpc('procesar_pago', {
                p_id: idTransaccion,
                p_nuevo_estado: nuevoEstado,
                p_admin_rif: currentUser.id || '',
                p_observacion: observacion
            });

            if (error) throw error;
            if (!data?.success) throw new Error(data?.error || 'Error al procesar pago');

            await syncDataFromCloud();
            renderAdminPayments();
            loadDashboardStats();
        } catch (err) {
            alert('Error al procesar: ' + err.message);
        } finally { hideLoader(); }
    };

    // ── FUNCIÓN: exportPaymentsExcel() ───────────────────────
    window.exportPaymentsExcel = function() {
        // Aplicar los mismos filtros activos
        let lista = pagosGlobal;
        if (filtrosPagos.rif)     lista = lista.filter(p => p.rif.includes(filtrosPagos.rif));
        if (filtrosPagos.status)  lista = lista.filter(p => p.status === filtrosPagos.status);
        if (filtrosPagos.metodo)  lista = lista.filter(p => p.metodo === filtrosPagos.metodo);

        const rows = [];
        lista.forEach(p => {
            const items = Array.isArray(p.desglosePagado) && p.desglosePagado.length > 0
                ? p.desglosePagado
                : [{ factura: p.factura, concepto: p.concepto || '-', monto: p.montoPagado }];
            items.forEach(it => {
                rows.push({
                    'Fecha':       p.fechaPago,
                    'Cliente':     p.rif,
                    'Factura':     it.factura || p.factura || '-',
                    'Tipo':        p.tipo === 'iva' ? 'IVA Bs' : 'USD',
                    'Concepto':    it.concepto || '-',
                    'Monto':       it.monto   || p.montoPagado,
                    'Método':      p.metodo,
                    'Referencia':  p.referencia,
                    'Estado':      p.status
                });
            });
        });

        if (!rows.length) return alert('No hay pagos para exportar con los filtros actuales.');
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'PAGOS');
        XLSX.writeFile(wb, `Pagos_${new Date().toISOString().split('T')[0]}.xlsx`);
    };

    // ── FUNCIÓN: exportCarteraExcel() ────────────────────────
    window.exportCarteraExcel = function() {
        const rows = [];
        for (const rif in facturasGlobal) {
            for (const [numFac, f] of Object.entries(facturasGlobal[rif])) {
                const dias  = diasDesde(f.fechaVencimiento);
                const estado = !f.fechaVencimiento ? 'Sin fecha'
                    : dias > 0  ? `Vencida ${dias}d` : dias > -8 ? 'Por vencer' : 'Vigente';
                rows.push({
                    'RIF':                rif,
                    'Factura':            numFac,
                    'Abierto USD':        f.abiertoUSD,
                    'IVA Bs':             f.ivaBs,
                    'Gran Total VES':     f.granTotalVES,
                    'Es Ajuste':          f.esAjuste ? 'Sí' : 'No',
                    'Fecha Vencimiento':  f.fechaVencimiento || '-',
                    'Estado':             estado
                });
            }
        }
        if (!rows.length) return alert('No hay cartera para exportar.');
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'CARTERA');
        XLSX.writeFile(wb, `Cartera_${new Date().toISOString().split('T')[0]}.xlsx`);
    };

    // ── Botón exportar pagos (ID existente) ──────────────────
    document.getElementById('btn-exportar')?.addEventListener('click', exportPaymentsExcel);

    // ── switchAdminTab: recargar datos al cambiar de pestaña ─
    window.switchAdminTab = function(tabName) {
        document.querySelectorAll('.admin-tab-content').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.tab-admin').forEach(el => el.classList.remove('active'));
        const tabEl = document.getElementById('admin-tab-' + tabName);
        if (tabEl) tabEl.classList.remove('hidden');
        if (event && event.currentTarget) event.currentTarget.classList.add('active');
        if (tabName === 'alertas')  loadAlerts();
        if (tabName === 'pagos')    renderAdminPayments();
        if (tabName === 'usuarios') renderAdminUsers();
        if (tabName === 'retenciones-admin') loadAdminRetenciones();
    };


    // ── Importar directorio (crea usuarios desde Excel) ───────
    window.importarDirectorio = function() {
        const fileEl = document.getElementById('directorio-file');
        if (!fileEl || !fileEl.files.length) return alert('Seleccione un archivo Excel de directorio.');

        showLoader('PROCESANDO DIRECTORIO...');
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const wb   = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
                const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);

                const norm = v => String(v || '').trim().toLowerCase().replace(/[\s_]+/g, '');
                function col(raw, ...aliases) {
                    for (const a of aliases) {
                        if (raw[a] !== undefined && raw[a] !== null && raw[a] !== '') return raw[a];
                        const an = norm(a);
                        for (const k of Object.keys(raw)) {
                            if (norm(k) === an) {
                                const val = raw[k];
                                if (val !== undefined && val !== null && val !== '') return val;
                            }
                        }
                    }
                    return '';
                }

                const csv = []; // para resumen
                for (const raw of rows) {
                    const nombreCliente = String(col(raw, 'Nombre', 'nombre', 'Socio del Negocio', 'Socio') || '').trim();
                    const codigoRif     = String(col(raw, 'Código', 'codigo', 'RIF', 'rif') || '').trim().toUpperCase();
                    const agenteComercial = String(col(raw, 'Agente Comercial', 'AgenteComercial', 'agente_comercial') || '').trim();
                    const agenteRaw    = String(col(raw, 'Agente de Retencion', 'Agente de Retención', 'agente_retencion') || '').trim().toLowerCase();
                    const esAgente     = agenteRaw === '1' || agenteRaw === 'true' || agenteRaw === 'si' || agenteRaw === 'sí';

                    if (!nombreCliente || !codigoRif) {
                        csv.push(`⚠️ Saltado: "${nombreCliente || '(vacio)'}" / "${codigoRif || '(vacio)'}"`);
                        continue;
                    }

                    // 1) Guardar en clientes_directorio (mapeo nombre → RIF)
                    await supabase.from('clientes_directorio').upsert(
                        { socio_nombre: nombreCliente, rif: codigoRif, agente_comercial: agenteComercial },
                        { onConflict: 'socio_nombre' }
                    );

                    // 2) Crear o actualizar usuario en usuarios
                    const { data: existe } = await supabase
                        .from('usuarios').select('rif').eq('rif', codigoRif).maybeSingle();

                    if (existe) {
                        // Ya existe → actualizar nombre y agente (no tocar password)
                        await supabase.from('usuarios').update({
                            nombre_empresa: nombreCliente,
                            es_agente_retencion: esAgente
                        }).eq('rif', codigoRif);
                        csv.push(`✅ Actualizado: ${codigoRif} — ${nombreCliente}`);
                    } else {
                        // Nuevo → crear con password = RIF
                        await supabase.from('usuarios').insert([{
                            rif: codigoRif,
                            nombre_empresa: nombreCliente,
                            password: codigoRif,
                            rol: 'cliente',
                            aprobado: true,
                            es_agente_retencion: esAgente
                        }]);
                        csv.push(`✅ Creado: ${codigoRif} — ${nombreCliente} (pass: ${codigoRif})`);
                    }
                }

                await renderAdminUsers();
                alert(`Directorio procesado.\n\n${csv.join('\n')}`);
            } catch (err) {
                alert('Error: ' + err.message);
            } finally { hideLoader(); }
        };
        reader.readAsArrayBuffer(fileEl.files[0]);
    };

    // --- CARGA DE CARTERA POR EXCEL (NUEVO FORMATO: Saldos_Abiertos) ---
    window.importarExcelCartera = function() {
        const fileEl = document.getElementById('excel-file');
        if (!fileEl || fileEl.files.length === 0) return alert('Seleccione un archivo Excel.');

        showLoader('PROCESANDO EXCEL DE SALDOS...');
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data     = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const sheet    = workbook.Sheets[workbook.SheetNames[0]];

                const rawAll = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                const norm = v => String(v || '').trim().toLowerCase().replace(/[*\s]+/g, ' ').trim();

                // Detectar fila de encabezados (buscar "Socio del Negocio" o "Abierto USD")
                let headerRow = 0;
                for (let i = 0; i < Math.min(rawAll.length, 5); i++) {
                    const celdas = (rawAll[i] || []).map(norm);
                    if (celdas.some(c => c.includes('socio') || c.includes('abierto usd'))) {
                        headerRow = i;
                        break;
                    }
                }

                const rows = XLSX.utils.sheet_to_json(sheet, { range: headerRow });

                function col(raw, ...aliases) {
                    for (const alias of aliases) {
                        if (raw[alias] !== undefined && raw[alias] !== null && raw[alias] !== '') return raw[alias];
                        const aliasNorm = norm(alias);
                        for (const key of Object.keys(raw)) {
                            if (norm(key) === aliasNorm) {
                                if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') return raw[key];
                            }
                        }
                    }
                    return undefined;
                }

                // Cargar directorio para mapeo Socio del Negocio → RIF
                const { data: directorio } = await supabase
                    .from('clientes_directorio').select('socio_nombre, rif');

                const dirMap = {};
                (directorio || []).forEach(d => { dirMap[d.socio_nombre.trim().toUpperCase()] = d.rif; });

                // ── Batch: recolectar todas las filas primero ──
                const invoicesBatch = [];
                const rifsNeeded = new Set();
                let errores = 0, erroresDetalle = [];

                for (const raw of rows) {
                    const socioNombre = String(col(raw, 'Socio del Negocio', 'Socio', 'Cliente') || '').trim();
                    const facturaRaw  = String(col(raw, 'Factura', 'Documento') || '').trim();
                    const abiertoUSD  = parseFloat(String(col(raw, 'Abierto USD', 'Abierto_USD') || '0').replace(/[^0-9.\-]/g, '')) || 0;
                    const granTotal   = parseFloat(String(col(raw, 'Gran Total', 'Gran_Total') || '0').replace(/[^0-9.\-]/g, '')) || 0;
                    const fechaVenc   = col(raw, 'F. Vencimiento', 'Fecha Vencimiento', 'Vencimiento') || null;

                    if (!socioNombre || !facturaRaw || abiertoUSD <= 0) {
                        if (socioNombre || facturaRaw) { errores++; erroresDetalle.push(`Fila incompleta: "${socioNombre}" / "${facturaRaw}"`); }
                        continue;
                    }

                    const rifCliente = dirMap[socioNombre.toUpperCase()];
                    if (!rifCliente) {
                        errores++; erroresDetalle.push(`"${socioNombre}" no encontrado en el directorio.`);
                        continue;
                    }

                    const numFactura = facturaRaw.split(/\s*-\s*/)[0].trim();
                    const esAjuste = /[a-zA-Z]/.test(numFactura);

                    let baseUSD, ivaBs;
                    if (esAjuste) {
                        baseUSD = abiertoUSD;
                        ivaBs   = 0;
                    } else {
                        baseUSD = abiertoUSD / 1.16;
                        ivaBs   = granTotal * (16 / 116);
                    }

                    rifsNeeded.add(rifCliente);
                    invoicesBatch.push({
                        rif_cliente:       rifCliente,
                        num_factura:       numFactura,
                        cliente_nombre:    socioNombre,
                        abierto_usd:       baseUSD,
                        abierto_usd_original: baseUSD,
                        iva_bs:            ivaBs,
                        fecha_vencimiento: fechaVenc,
                        gran_total_ves:    granTotal,
                        es_ajuste:         esAjuste
                    });
                }

                // ── Batch: crear usuarios faltantes (1 query) ──
                if (rifsNeeded.size > 0) {
                    const { data: existingUsers } = await supabase
                        .from('usuarios').select('rif').in('rif', [...rifsNeeded]);
                    const existingSet = new Set((existingUsers || []).map(u => u.rif));
                    const newUsers = [...rifsNeeded]
                        .filter(r => !existingSet.has(r))
                        .map(r => ({ rif: r, password: '', rol: 'cliente', aprobado: false }));

                    if (newUsers.length > 0) {
                        const { error: insertErr } = await supabase
                            .from('usuarios').insert(newUsers);
                        if (insertErr) { errores++; erroresDetalle.push('Error creando usuarios: ' + insertErr.message); }
                    }
                }

                // ── Batch: upsert facturas en chunks de 500 ──
                const CHUNK = 500;
                let insertadas = 0;
                for (let i = 0; i < invoicesBatch.length; i += CHUNK) {
                    const chunk = invoicesBatch.slice(i, i + CHUNK);
                    const { error: upsertErr } = await supabase
                        .from('facturas_saldos')
                        .upsert(chunk, { onConflict: 'rif_cliente,num_factura' });

                    if (upsertErr) {
                        errores += chunk.length;
                        erroresDetalle.push(`Lote ${i/CHUNK + 1}: ${upsertErr.message}`);
                    } else {
                        insertadas += chunk.length;
                    }
                }

                await syncDataFromCloud();
                loadDashboardStats();

                let msg = `Carga completada.\n✅ Facturas procesadas: ${insertadas}\n⚠️ Errores: ${errores}`;
                if (erroresDetalle.length) msg += '\n\n' + erroresDetalle.slice(0, 5).join('\n');
                alert(msg);
            } catch (err) {
                alert('Error: ' + err.message);
            } finally { hideLoader(); }
        };
        reader.readAsArrayBuffer(fileEl.files[0]);
    };


    // --- ARCHIVAR FACTURAS LIQUIDADAS ---
    window.archivarOrdenesLiquidadas = async function() {
        showLoader('VERIFICANDO FACTURAS A ARCHIVAR...');
        try {
            // 1. Obtener facturas con saldo cero
            const { data: liquidadas, error: err1 } = await supabase
                .from('facturas_saldos').select('*').lte('abierto_usd', 0).limit(2000);
            if (err1) throw err1;
            if (!liquidadas || liquidadas.length === 0) {
                alert('No hay facturas con saldo cero para archivar.');
                hideLoader(); return;
            }

            // 2. Obtener pagos aprobados relacionados (para filtrar por fecha)
            const { data: pagosRel, error: err2 } = await supabase
                .from('pagos').select('rif_cliente, num_factura, fecha_pago, monto_pagado, metodo, referencia, status, procesado_por, fecha_procesado, desglose_pagado')
                .eq('status', 'Aprobado')
                .limit(5000);
            if (err2) throw err2;

            // 3. Para cada factura, buscar el pago más reciente
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

            const aArchivar = [];
            const noArchivar = []; // facturas con pagos recientes (< 6 meses)

            for (const inv of liquidadas) {
                const misPagos = (pagosRel || []).filter(p =>
                    p.rif_cliente === inv.rif_cliente
                    && (p.num_factura === inv.num_factura
                        || p.num_factura.includes(inv.num_factura))
                );
                if (misPagos.length === 0) {
                    // Sin pagos aprobados → se archiva igual
                    aArchivar.push(inv);
                    continue;
                }
                const fechas = misPagos.map(p => new Date(p.fecha_pago));
                const ultima = new Date(Math.max(...fechas));
                if (ultima < sixMonthsAgo) {
                    aArchivar.push(inv);
                } else {
                    noArchivar.push(inv);
                }
            }

            if (aArchivar.length === 0) {
                alert('No hay facturas con pagos mayores a 6 meses para archivar.\n' +
                    (noArchivar.length > 0 ? `${noArchivar.length} factura(s) tienen pagos recientes (< 6 meses).` : ''));
                hideLoader(); return;
            }

            // 4. Generar Excel de respaldo
            const wb = XLSX.utils.book_new();

            // Hoja 1: Facturas a archivar
            const facturasData = aArchivar.map(inv => ({
                'RIF':          inv.rif_cliente,
                'Factura':      inv.num_factura,
                'Cliente':      inv.cliente_nombre || '',
                'Abierto USD':  parseFloat(inv.abierto_usd) || 0,
                'IVA Bs':       parseFloat(inv.iva_bs) || 0,
                'Gran Total VES': parseFloat(inv.gran_total_ves) || 0,
                'Es Ajuste':    inv.es_ajuste ? 'Sí' : 'No',
                'Vencimiento':  inv.fecha_vencimiento || ''
            }));
            const ws1 = XLSX.utils.json_to_sheet(facturasData);
            XLSX.utils.book_append_sheet(wb, ws1, 'Facturas Archivadas');

            // Hoja 2: Pagos relacionados
            const pagosData = [];
            for (const inv of aArchivar) {
                const relacionados = (pagosRel || []).filter(p =>
                    p.rif_cliente === inv.rif_cliente
                    && (p.num_factura === inv.num_factura
                        || p.num_factura.includes(inv.num_factura))
                );
                relacionados.forEach(p => {
                    pagosData.push({
                        'RIF':          p.rif_cliente,
                        'Factura':      inv.num_factura,
                        'Monto USD':    parseFloat(p.monto_pagado) || 0,
                        'Método':       p.metodo || '',
                        'Referencia':   p.referencia || '',
                        'Fecha Pago':   p.fecha_pago || '',
                        'Status':       p.status || '',
                        'Procesado por': p.procesado_por || '',
                        'Fecha Proc.':  p.fecha_procesado || ''
                    });
                });
            }
            if (pagosData.length > 0) {
                const ws2 = XLSX.utils.json_to_sheet(pagosData);
                XLSX.utils.book_append_sheet(wb, ws2, 'Pagos Relacionados');
            }

            const ts = new Date().toISOString().slice(0,10);
            XLSX.writeFile(wb, `respaldo_facturas_${ts}.xlsx`);

            // 5. Confirmar borrado
            if (!confirm(`✅ Respaldo descargado: ${aArchivar.length} factura(s) y ${pagosData.length} pago(s).\n\n` +
                (noArchivar.length > 0 ? `⚠️ ${noArchivar.length} factura(s) NO se archivan (pago < 6 meses).\n\n` : '') +
                '¿Proceder con el archivo?')) {
                hideLoader(); return;
            }

            // 6. Borrar usando RPC batch
            const facturasPayload = aArchivar.map(inv => ({
                rif_cliente: inv.rif_cliente,
                num_factura: inv.num_factura
            }));

            const { data: res, error: err3 } = await supabase
                .rpc('archivar_facturas_lote', { p_facturas: facturasPayload });
            if (err3) throw err3;

            await syncDataFromCloud();
            loadDashboardStats();
            alert(`Archivo completado. ${res?.archivadas || aArchivar.length} factura(s) eliminadas junto con sus pagos.`);
        } catch (err) {
            alert('Error: ' + err.message);
        } finally { hideLoader(); }
    };


    // (exportación de pagos manejada por exportPaymentsExcel() en el módulo admin)


    // =========================================================
    // MÓDULO 7: CLIENTE - ESTADO DE CUENTA (BASE USD)
    // =========================================================
    function loadClientInvoices() {
        const container      = document.getElementById('invoices-container');
        const pazYSalvo      = document.getElementById('paz-y-salvo');
        const debtContainer  = document.getElementById('client-debt-container');

        container.innerHTML  = '';
        selectedTotal        = 0;
        desglosePagadoGlobal = [];
        document.getElementById('total-amount').textContent      = "0.00";
        document.getElementById('btn-submit-payment').disabled   = true;

        const inputMontoForm = document.getElementById('pago-monto');
        if (inputMontoForm) inputMontoForm.value = '';

        const misFacturas  = facturasGlobal[currentUser.id] || {};
        let deudaTotalUSD  = 0;
        let html           = '';

        for (const [numFactura, datos] of Object.entries(misFacturas)) {
            const saldoUSD = datos.abiertoUSD;
            if (saldoUSD <= 0) continue;
            deudaTotalUSD += saldoUSD;

            const tipoTag = datos.esAjuste
                ? '<span style="background:#c084fc20;color:#c084fc;padding:2px 8px;border-radius:8px;font-size:10px;border:1px solid #c084fc40;margin-left:8px;">AJUSTE</span>'
                : '';

            html += `
                <div class="card liquid-glass" style="padding:18px 20px;">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;">
                        <div style="flex:1;min-width:150px;">
                            <strong style="color:#3b82f6;font-size:16px;">Factura ${numFactura}</strong>${tipoTag}
                            <span style="display:block;font-size:12px;color:rgba(255,255,255,0.5);margin-top:4px;">
                                Vence: ${datos.fechaVencimiento || 'No especificada'}
                            </span>
                        </div>
                        <div style="text-align:right;min-width:140px;">
                            <span style="font-size:11px;color:rgba(255,255,255,0.4);display:block;">MONTO MÁX. USD</span>
                            <span class="font-serif" style="font-size:22px;color:#22c55e;">$${saldoUSD.toFixed(2)}</span>
                        </div>
                    </div>
                    <div style="margin-top:10px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                        <span style="font-size:13px;color:rgba(255,255,255,0.7);">¿Cuánto abona?</span>
                        <div style="display:flex;align-items:center;gap:6px;background:rgba(0,0,0,0.3);padding:8px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.1);">
                            <span style="color:rgba(255,255,255,0.5);">$</span>
                            <input type="number" class="factura-abono-input"
                                   data-factura="${numFactura}"
                                   data-es-ajuste="${datos.esAjuste}"
                                   max="${saldoUSD.toFixed(2)}"
                                   min="0"
                                   step="0.01"
                                   placeholder="0.00"
                                   style="width:120px;background:transparent;border:none;outline:none;color:#22c55e;font-size:16px;font-weight:bold;">
                            <span style="color:rgba(255,255,255,0.3);font-size:11px;">/ ${saldoUSD.toFixed(2)}</span>
                        </div>
                    </div>
                </div>`;
        }

        if (deudaTotalUSD <= 0 && Object.keys(misFacturas).length > 0) {
            pazYSalvo.classList.remove('hidden');
            debtContainer.classList.add('hidden');
        } else {
            pazYSalvo.classList.add('hidden');
            debtContainer.classList.remove('hidden');
            container.innerHTML = html || '<p style="color:rgba(255,255,255,0.4);text-align:center;padding:20px;">No tiene facturas pendientes.</p>';
        }

        // Eventos inputs de abono
        document.querySelectorAll('.factura-abono-input').forEach(input => {
            input.addEventListener('input', recalcularAbonosUSD);
            input.addEventListener('blur', function() {
                const max = parseFloat(this.getAttribute('max'));
                let val = parseFloat(this.value) || 0;
                if (val > max) this.value = max.toFixed(2);
                if (val < 0) this.value = '0';
                recalcularAbonosUSD();
            });
        });
    }

    function recalcularAbonosUSD() {
        selectedTotal        = 0;
        desglosePagadoGlobal = [];
        let tieneAjuste = false;

        document.querySelectorAll('.factura-abono-input').forEach(input => {
            const val = parseFloat(input.value) || 0;
            if (val > 0) {
                selectedTotal += val;
                desglosePagadoGlobal.push({
                    factura:  input.getAttribute('data-factura'),
                    concepto: 'BaseImponible',
                    monto:    val
                });
                if (input.getAttribute('data-es-ajuste') === 'true') {
                    tieneAjuste = true;
                }
            }
        });

        document.getElementById('total-amount').textContent      = selectedTotal.toFixed(2);
        document.getElementById('btn-submit-payment').disabled   = selectedTotal <= 0;
        const inMonto = document.getElementById('pago-monto');
        if (inMonto) inMonto.value = selectedTotal > 0 ? selectedTotal.toFixed(2) : '';

        actualizarMetodosPago(tieneAjuste);
    }

    function actualizarMetodosPago(tieneAjuste) {
        const vesGroup = document.getElementById('pago-metodo-ves-group');
        const vesNotice = document.getElementById('usd-ves-notice');
        const metodoSelect = document.getElementById('pago-metodo');
        const isVES = metodoSelect.value === 'Transferencia VES' || metodoSelect.value === 'Pago Móvil';

        if (vesGroup) {
            vesGroup.style.display = tieneAjuste ? 'none' : '';
        }

        if (tieneAjuste && isVES) {
            metodoSelect.value = '';
        }

        if (vesNotice) {
            vesNotice.classList.toggle('hidden', !isVES || tieneAjuste);
        }
    }

    // =========================================================
    // MÓDULO 7B: CLIENTE - IVA (Bs)
    // =========================================================
    function loadClientIVA() {
        const container      = document.getElementById('iva-invoices-container');
        const pazYSalvo      = document.getElementById('paz-y-salvo-iva');
        const debtContainer  = document.getElementById('iva-debt-container');
        const agenteNotice   = document.getElementById('iva-agente-notice');

        container.innerHTML  = '';
        selectedIVATotal     = 0;
        desgloseIVAGlobal    = [];
        document.getElementById('iva-total-amount').textContent   = "0.00";
        document.getElementById('btn-submit-iva-payment').disabled = true;

        // Mostrar banner de agente de retención si aplica
        if (agenteNotice) {
            agenteNotice.classList.toggle('hidden', !currentUser.esAgenteRetencion);
        }

        const misFacturas = facturasGlobal[currentUser.id] || {};
        let totalIVAPend  = 0;
        let html          = '';

        for (const [numFactura, datos] of Object.entries(misFacturas)) {
            const iva = datos.ivaBs;
            if (iva <= 0) continue;
            totalIVAPend += iva;

            const ivaPagar = currentUser.esAgenteRetencion ? iva * 0.25 : iva;

            html += `
                <div class="card liquid-glass" style="padding:18px 20px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
                        <div>
                            <strong style="color:#eab308;font-size:15px;">Factura ${numFactura}</strong>
                            <span style="display:block;font-size:12px;color:rgba(255,255,255,0.5);margin-top:3px;">
                                Vence: ${datos.fechaVencimiento || 'No especificada'}
                            </span>
                        </div>
                        <div style="display:flex;align-items:center;gap:15px;">
                            <span style="font-size:13px;color:rgba(255,255,255,0.6);">IVA:</span>
                            <span class="font-serif" style="font-size:20px;color:#eab308;">Bs ${iva.toFixed(2)}</span>
                            ${currentUser.esAgenteRetencion
                                ? `<span style="font-size:11px;color:#c084fc;background:#c084fc20;padding:2px 8px;border-radius:8px;">Paga Bs ${ivaPagar.toFixed(2)} (25%)</span>`
                                : ''}
                            <label style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:14px;color:rgba(255,255,255,0.8);">
                                <input type="checkbox" class="iva-toggle-chk"
                                       data-factura="${numFactura}"
                                       data-monto="${iva.toFixed(2)}"
                                       data-pagar="${ivaPagar.toFixed(2)}"
                                       style="width:20px;height:20px;accent-color:#eab308;">
                                Pagar
                            </label>
                        </div>
                    </div>
                </div>`;
        }

        if (totalIVAPend <= 0) {
            pazYSalvo.classList.remove('hidden');
            debtContainer.style.display = 'none';
        } else {
            pazYSalvo.classList.add('hidden');
            debtContainer.style.display = 'block';
            container.innerHTML = html;
        }

        document.querySelectorAll('.iva-toggle-chk').forEach(chk => {
            chk.addEventListener('change', recalcularIVA);
        });
    }

    function recalcularIVA() {
        selectedIVATotal  = 0;
        desgloseIVAGlobal = [];
        let totalAPagar   = 0;

        document.querySelectorAll('.iva-toggle-chk:checked').forEach(chk => {
            const montoFull = parseFloat(chk.getAttribute('data-monto')) || 0;
            const montoPagar = parseFloat(chk.getAttribute('data-pagar')) || montoFull;
            selectedIVATotal += montoFull;
            totalAPagar += montoPagar;
            desgloseIVAGlobal.push({
                factura:  chk.getAttribute('data-factura'),
                concepto: 'IVA',
                monto:    montoPagar
            });
        });

        document.getElementById('iva-total-amount').textContent    = selectedIVATotal.toFixed(2);
        document.getElementById('btn-submit-iva-payment').disabled = totalAPagar <= 0;
        const inMonto = document.getElementById('iva-pago-monto');
        if (inMonto) inMonto.value = totalAPagar > 0 ? totalAPagar.toFixed(2) : '';

        // Mostrar notificación de consultar asesor (siempre que haya monto > 0)
        const notice = document.getElementById('iva-bs-notice');
        if (notice) {
            if (totalAPagar > 0) notice.classList.remove('hidden');
            else notice.classList.add('hidden');
        }
    }


    // =========================================================
    // MÓDULO 8A: CLIENTE - ENVÍO DE PAGO USD (Estado de Cuenta)
    // =========================================================

    // Change handler para métodos VES: mostrar/ocultar aviso
    document.getElementById('pago-metodo').addEventListener('change', function() {
        const vesNotice = document.getElementById('usd-ves-notice');
        const isVES = this.value === 'Transferencia VES' || this.value === 'Pago Móvil';
        if (vesNotice) {
            vesNotice.classList.toggle('hidden', !isVES);
        }
    });

    document.getElementById('payment-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = document.getElementById('payment-error');
        errorEl.classList.add('hidden');

        const montoPagado    = selectedTotal;
        const metodoAsignado = document.getElementById('pago-metodo').value;
        const referencia     = document.getElementById('pago-ref').value.trim();
        const fechaPago      = document.getElementById('pago-date').value;

        if (montoPagado <= 0) {
            errorEl.textContent = "Debe ingresar un monto a pagar.";
            errorEl.classList.remove('hidden'); return;
        }
        if (!metodoAsignado) {
            errorEl.textContent = "Debe seleccionar el método de pago.";
            errorEl.classList.remove('hidden'); return;
        }

        const isVES = metodoAsignado === 'Transferencia VES' || metodoAsignado === 'Pago Móvil';
        if (isVES) {
            const tieneAjuste = desglosePagadoGlobal.some(c => {
                const datos = facturasGlobal[currentUser.id]?.[c.factura];
                return datos && datos.esAjuste;
            });
            if (tieneAjuste) {
                errorEl.textContent = "Los ajustes solo pueden pagarse en USD. Desmarque los ajustes o cambie el método de pago.";
                errorEl.classList.remove('hidden'); return;
            }
        }

        if (!referencia) {
            errorEl.textContent = "Debe ingresar el número de referencia.";
            errorEl.classList.remove('hidden'); return;
        }
        if (!fechaPago) {
            errorEl.textContent = "Debe ingresar la fecha del pago.";
            errorEl.classList.remove('hidden'); return;
        }

        const facturasUnicas = Array.from(new Set(desglosePagadoGlobal.map(c => c.factura))).join(' / ');

        const file  = document.getElementById('pago-soporte').files[0];
        const txId  = 'TX-' + Date.now();

        showLoader('SUBIENDO COMPROBANTE...');
        try {
            let soporte_url = null;

            if (file) {
                const ext      = file.name.split('.').pop().toLowerCase();
                const fileName = `${currentUser.id}/${txId}.${ext}`;
                const { error: uploadErr } = await supabase.storage
                    .from('soportes_pago')
                    .upload(fileName, file, { contentType: file.type, upsert: false });
                if (uploadErr) throw uploadErr;

                const { data: urlData } = supabase.storage
                    .from('soportes_pago')
                    .getPublicUrl(fileName);
                soporte_url = urlData?.publicUrl || null;
            }

            showLoader('REGISTRANDO PAGO...');

            const { error: insertErr } = await supabase.from('pagos').insert([{
                id:              txId,
                rif_cliente:     currentUser.id,
                num_factura:     facturasUnicas,
                concepto:        'BaseImponible',
                monto_pagado:    montoPagado,
                metodo:          metodoAsignado,
                referencia:      referencia,
                fecha_pago:      fechaPago,
                status:          'Pendiente',
                soporte_url:     soporte_url,
                tipo_pago:       'base',
                desglose_pagado: desglosePagadoGlobal
            }]);

            if (insertErr) throw insertErr;

            document.getElementById('payment-form').reset();
            selectedTotal        = 0;
            desglosePagadoGlobal = [];
            showView('success');

        } catch (err) {
            errorEl.textContent = 'Error: ' + err.message;
            errorEl.classList.remove('hidden');
        } finally { hideLoader(); }
    });

    // =========================================================
    // MÓDULO 8B: CLIENTE - ENVÍO DE PAGO IVA (Bs)
    // =========================================================
    document.getElementById('iva-payment-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = document.getElementById('iva-payment-error');
        errorEl.classList.add('hidden');

        const montoPagado    = parseFloat(document.getElementById('iva-pago-monto').value) || 0;
        const metodoAsignado = document.getElementById('iva-pago-metodo').value;
        const referencia     = document.getElementById('iva-pago-ref').value.trim();
        const fechaPago      = document.getElementById('iva-pago-date').value;

        if (montoPagado <= 0) {
            errorEl.textContent = "Debe seleccionar al menos una factura para pagar IVA.";
            errorEl.classList.remove('hidden'); return;
        }
        if (!metodoAsignado) {
            errorEl.textContent = "Debe seleccionar el método de pago.";
            errorEl.classList.remove('hidden'); return;
        }
        if (!referencia) {
            errorEl.textContent = "Debe ingresar el número de referencia.";
            errorEl.classList.remove('hidden'); return;
        }
        if (!fechaPago) {
            errorEl.textContent = "Debe ingresar la fecha del pago.";
            errorEl.classList.remove('hidden'); return;
        }

        const facturasUnicas = Array.from(new Set(desgloseIVAGlobal.map(c => c.factura))).join(' / ');

        const file  = document.getElementById('iva-pago-soporte').files[0];
        const txId  = 'IVA-' + Date.now();

        showLoader('SUBIENDO COMPROBANTE...');
        try {
            let soporte_url = null;

            if (file) {
                const ext      = file.name.split('.').pop().toLowerCase();
                const fileName = `${currentUser.id}/${txId}.${ext}`;
                const { error: uploadErr } = await supabase.storage
                    .from('soportes_pago')
                    .upload(fileName, file, { contentType: file.type, upsert: false });
                if (uploadErr) throw uploadErr;

                const { data: urlData } = supabase.storage
                    .from('soportes_pago')
                    .getPublicUrl(fileName);
                soporte_url = urlData?.publicUrl || null;
            }

            showLoader('REGISTRANDO PAGO IVA...');

            const { error: insertErr } = await supabase.from('pagos').insert([{
                id:              txId,
                rif_cliente:     currentUser.id,
                num_factura:     facturasUnicas,
                concepto:        'IVA',
                monto_pagado:    montoPagado,
                metodo:          metodoAsignado,
                referencia:      referencia,
                fecha_pago:      fechaPago,
                status:          'Pendiente',
                soporte_url:     soporte_url,
                tipo_pago:       'iva',
                desglose_pagado: desgloseIVAGlobal
            }]);

            if (insertErr) throw insertErr;

            document.getElementById('iva-payment-form').reset();
            selectedIVATotal  = 0;
            desgloseIVAGlobal = [];
            showView('success');

        } catch (err) {
            errorEl.textContent = 'Error: ' + err.message;
            errorEl.classList.remove('hidden');
        } finally { hideLoader(); }
    });


    // =========================================================
    // MÓDULO 9: CLIENTE - HISTORIAL DE PAGOS
    // =========================================================
    function loadClientHistory() {
        const tbody = document.getElementById('client-history-tbody');
        tbody.innerHTML = '';
        const misPagos = pagosGlobal.filter(p => p.rif === currentUser.id);

        if (misPagos.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:rgba(255,255,255,0.4);">No tiene operaciones reportadas.</td></tr>';
            return;
        }

        misPagos.forEach(pago => {
            let badgeColor = pago.status === 'Aprobado' ? '#22c55e' :
                             pago.status === 'Rechazado' ? '#ef4444' : '#eab308';
            const tipoLabel = pago.tipo === 'iva'
                ? '<span style="color:#eab308;font-size:11px;">[IVA Bs]</span>'
                : '<span style="color:#22c55e;font-size:11px;">[USD]</span>';
            const moneda = pago.tipo === 'iva' ? 'Bs ' : '$';

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${pago.fechaPago}</td>
                <td>${pago.factura || '-'}</td>
                <td>${pago.concepto || '-'} ${tipoLabel}</td>
                <td class="font-serif" style="font-size:16px;">${moneda}${pago.montoPagado.toFixed(2)}</td>
                <td>${pago.metodo}</td>
                <td>${pago.referencia}</td>
                <td><span style="background:${badgeColor}20; color:${badgeColor}; padding:4px 8px; border-radius:12px; font-size:12px; border:1px solid ${badgeColor}40;">${pago.status}</span></td>
            `;

            if (pago.soporte_url) {
                const tdSop = document.createElement('td');
                const btn   = document.createElement('button');
                btn.className = 'btn-outline';
                btn.style.cssText = 'padding:4px 8px; font-size:12px;';
                btn.textContent = 'Ver Soporte';
                btn.addEventListener('click', () => abrirModalSoporte(pago.soporte_url));
                tdSop.appendChild(btn);
                tr.appendChild(tdSop);
            } else {
                const tdSop = document.createElement('td');
                tdSop.innerHTML = '<span style="font-size:11px; color:rgba(255,255,255,0.3);">-</span>';
                tr.appendChild(tdSop);
            }

            tbody.appendChild(tr);
        });
    }


    // =========================================================
    // MÓDULO 10: BOTÓN "CONTINUAR" EN PANTALLA DE ÉXITO
    // =========================================================
    document.getElementById('btn-restart').addEventListener('click', async () => {
        showLoader('ACTUALIZANDO DATOS...');
        try {
            await syncDataFromCloud();
            loadClientInvoices();
            showView('client');
        } catch (err) {
            console.error(err);
        } finally { hideLoader(); }
    });


    // =========================================================
    // ▌MÓDULO 11: GESTIÓN ADMIN DE USUARIOS / EMPRESAS
    // =========================================================

    // ── Estado edición ────────────────────────────────────────
    let editandoUsuarioRif = null;   // null = modo crear, rif = modo editar

    // ── Abrir modal gestión de usuarios ──────────────────────
    window.abrirModalUsuario = function(rifExistente = null) {
        editandoUsuarioRif = rifExistente;
        const modal  = document.getElementById('modal-usuario');
        const titulo = document.getElementById('modal-usuario-titulo');
        if (!modal) return;

        ['mu-rif','mu-nombre','mu-email','mu-telefono','mu-password'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const chkActivo = document.getElementById('mu-activo');
        const chkAgente = document.getElementById('mu-agente');
        if (chkActivo) chkActivo.checked = true;
        if (chkAgente) chkAgente.checked = false;
        document.getElementById('mu-rif').disabled = false;
        document.getElementById('mu-error').classList.add('hidden');

        if (rifExistente) {
            titulo.textContent = 'Editar Empresa';
            // Cargar datos actuales
            supabase.from('usuarios').select('*').eq('rif', rifExistente).maybeSingle().then(({ data }) => {
                if (!data) return;
                document.getElementById('mu-rif').value      = data.rif;
                document.getElementById('mu-rif').disabled   = true;
                document.getElementById('mu-nombre').value   = data.nombre_empresa  || '';
                document.getElementById('mu-email').value    = data.email           || '';
                document.getElementById('mu-telefono').value = data.telefono        || '';
                if (chkActivo) chkActivo.checked = !!data.aprobado;
                if (chkAgente) chkAgente.checked = !!data.es_agente_retencion;
            });
        } else {
            titulo.textContent = 'Nueva Empresa / Usuario';
        }

        modal.style.display = 'flex';
    };

    window.cerrarModalUsuario = function() {
        const modal = document.getElementById('modal-usuario');
        if (modal) modal.style.display = 'none';
        editandoUsuarioRif = null;
    };

    // ── Guardar usuario (crear o editar) ─────────────────────
    document.getElementById('form-modal-usuario')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errEl   = document.getElementById('mu-error');
        errEl.classList.add('hidden');
        showLoader('GUARDANDO USUARIO...');

        const rif     = document.getElementById('mu-rif').value.trim().toUpperCase();
        const nombre  = document.getElementById('mu-nombre').value.trim();
        const email   = document.getElementById('mu-email').value.trim();
        const tel     = document.getElementById('mu-telefono').value.trim();
        const pass    = document.getElementById('mu-password').value;
        const activo  = document.getElementById('mu-activo').checked;
        const esAgente = document.getElementById('mu-agente')?.checked || false;

        try {
            if (!rif) throw new Error('El RIF es obligatorio.');

            if (editandoUsuarioRif) {
                const update = { nombre_empresa: nombre, email, telefono: tel, aprobado: activo, es_agente_retencion: esAgente };
                if (pass) update.password = pass;
                const { error } = await supabase.from('usuarios').update(update).eq('rif', editandoUsuarioRif);
                if (error) throw error;
            } else {
                if (!pass) throw new Error('La contraseña es obligatoria para usuarios nuevos.');
                const { data: existe } = await supabase.from('usuarios').select('rif').eq('rif', rif).maybeSingle();
                if (existe) throw new Error('Ya existe un usuario con ese RIF.');
                const { error } = await supabase.from('usuarios').insert([{
                    rif, nombre_empresa: nombre, email, telefono: tel,
                    password: pass, rol: 'cliente',
                    aprobado: activo,
                    es_agente_retencion: esAgente
                }]);
                if (error) throw error;
            }

            cerrarModalUsuario();
            await renderAdminUsers();
        } catch (err) {
            errEl.textContent = err.message;
            errEl.classList.remove('hidden');
        } finally { hideLoader(); }
    });

    // ── Importar usuarios desde Excel ────────────────────────
    window.importarExcelUsuarios = function() {
        const fileEl = document.getElementById('excel-usuarios-file');
        if (!fileEl || !fileEl.files.length) return alert('Seleccione un archivo Excel.');

        showLoader('PROCESANDO USUARIOS...');
        const reader = new FileReader();
        reader.onload = async (ev) => {
            try {
                const wb   = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' });
                const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
                const norm = v => String(v || '').trim().toLowerCase().replace(/[\s_]+/g,'');

                function col(raw, ...aliases) {
                    for (const a of aliases) {
                        if (raw[a] !== undefined) return raw[a];
                        const an = norm(a);
                        for (const k of Object.keys(raw)) {
                            if (norm(k) === an) return raw[k];
                        }
                    }
                    return '';
                }

                let creados = 0, errores = 0, detalle = [];

                for (const raw of rows) {
                    const rif    = String(col(raw,'RIF','rif') || '').trim().toUpperCase();
                    const nombre = String(col(raw,'Nombre Empresa','NombreEmpresa','nombre_empresa','Nombre') || '').trim();
                    const pass   = String(col(raw,'Password','password','Contraseña','contrasena') || '').trim();
                    const email  = String(col(raw,'Email','email','correo') || '').trim();
                    const tel    = String(col(raw,'Telefono','telefono','Teléfono','phone') || '').trim();
                    const agenteRaw = String(col(raw,'Agente Retencion','Agente de Retencion','agente_retencion','es_agente_retencion') || '').trim().toLowerCase();
                    const esAgente = agenteRaw === '1' || agenteRaw === 'true' || agenteRaw === 'si' || agenteRaw === 'sí';

                    if (!rif || !pass) {
                        errores++;
                        detalle.push(`Fila sin RIF o password: "${rif}"`);
                        continue;
                    }

                    const { error } = await supabase.from('usuarios').upsert({
                        rif, nombre_empresa: nombre, email, telefono: tel,
                        password: pass, rol: 'cliente',
                        aprobado: true,
                        es_agente_retencion: esAgente
                    }, { onConflict: 'rif' });

                    if (error) { errores++; detalle.push(`${rif}: ${error.message}`); }
                    else creados++;
                }

                await renderAdminUsers();
                let msg = `✅ Usuarios procesados: ${creados}\n⚠️ Errores: ${errores}`;
                if (detalle.length) msg += '\n\n' + detalle.slice(0,5).join('\n');
                alert(msg);
            } catch (err) {
                alert('Error al importar: ' + err.message);
            } finally { hideLoader(); }
        };
        reader.readAsArrayBuffer(fileEl.files[0]);
    };

    // ── Override renderAdminUsers: muestra datos extendidos ──
    // (reemplaza la función del módulo 5 enriqueciéndola)
    async function renderAdminUsers() {
        const tbody = document.getElementById('admin-users-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:rgba(255,255,255,0.4);padding:16px;">Cargando...</td></tr>';

        const { data: usuarios } = await supabase
            .from('usuarios').select('*').eq('rol','cliente').order('created_at', { ascending: false }).limit(500);

        if (!usuarios || !usuarios.length) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:rgba(255,255,255,0.4);padding:16px;">No hay clientes registrados.</td></tr>';
            return;
        }

        tbody.innerHTML = '';
        usuarios.forEach(u => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="font-family:monospace;color:#3b82f6;">${u.rif}</td>
                <td>${u.nombre_empresa || '<span style="color:rgba(255,255,255,0.3);">-</span>'}</td>
                <td style="font-size:12px;">${u.email || '-'}</td>
                <td style="font-size:12px;">${u.telefono || '-'}</td>
                <td style="font-size:12px;text-align:center;">
                    ${u.es_agente_retencion
                        ? '<span style="color:#c084fc;font-size:13px;">✓</span>'
                        : '<span style="color:rgba(255,255,255,0.2);">-</span>'}
                </td>
                <td>
                    <span style="color:${u.aprobado?'#22c55e':'#ef4444'};font-size:12px;">
                        ${u.aprobado ? 'Activo' : 'Inactivo'}
                    </span>
                </td>
            `;
            // Botones acción
            const tdAcc = document.createElement('td');
            tdAcc.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
            const bEdit = document.createElement('button');
            bEdit.className = 'btn-outline';
            bEdit.style.cssText = 'padding:4px 10px;font-size:11px;';
            bEdit.textContent = '✏️ Editar';
            bEdit.addEventListener('click', () => abrirModalUsuario(u.rif));
            tdAcc.appendChild(bEdit);
            if (!u.aprobado) {
                const bApr = document.createElement('button');
                bApr.className = 'btn-solid';
                bApr.style.cssText = 'padding:4px 10px;font-size:11px;background:#22c55e;color:black;';
                bApr.textContent = '✓ Activar';
                bApr.addEventListener('click', () => aprobarUsuarioNube(u.rif));
                tdAcc.appendChild(bApr);
            }
            tr.appendChild(tdAcc);
            tbody.appendChild(tr);
        });
    }
    window.renderAdminUsers = renderAdminUsers;   // exponer para switchAdminTab


    // =========================================================
    // ▌MÓDULO 13: COMPROBANTES DE RETENCIÓN IVA (CLIENTE)
    // =========================================================

    async function loadClientRetenciones() {
        const container = document.getElementById('retenciones-container');
        if (!container) return;
        container.innerHTML = '<p style="color:rgba(255,255,255,0.4);text-align:center;padding:20px;">Cargando...</p>';

        const misFacturas = facturasGlobal[currentUser.id] || {};
        const facturasConIVA = Object.entries(misFacturas)
            .filter(([, d]) => d.ivaBs > 0);

        if (!facturasConIVA.length) {
            container.innerHTML = '<p style="color:rgba(255,255,255,0.4);text-align:center;padding:20px;">No tiene facturas con IVA pendiente.</p>';
            return;
        }

        // Comprobantes ya subidos
        const { data: comprobantes } = await supabase
            .from('comprobantes_retencion')
            .select('*')
            .eq('rif_cliente', currentUser.id);

        const compMap = {};
        (comprobantes || []).forEach(c => { compMap[c.num_factura] = c; });

        let html = '';
        for (const [numFac, datos] of facturasConIVA) {
            const ivaCompleto = datos.ivaBs;
            const montoRetener = ivaCompleto * 0.75;
            const comp = compMap[numFac];
            const estado = comp ? comp.estado : 'Pendiente';
            const colEst = estado === 'Aprobado' ? '#22c55e' : estado === 'Rechazado' ? '#ef4444' : '#eab308';
            const obs = comp?.observacion_admin
                ? `<p style="color:#ef4444;font-size:12px;margin:5px 0 0;">⚠️ ${comp.observacion_admin}</p>`
                : '';

            html += `
            <div class="card liquid-glass" style="margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
                    <div>
                        <strong style="color:#3b82f6;">Factura ${numFac}</strong>
                        <span style="display:block;font-size:13px;color:rgba(255,255,255,0.6);">
                            IVA total: <span class="font-serif" style="color:#eab308;">Bs ${ivaCompleto.toFixed(2)}</span>
                            &nbsp;|&nbsp; Retiene 75%: <span class="font-serif" style="color:#c084fc;">Bs ${montoRetener.toFixed(2)}</span>
                        </span>
                        ${obs}
                    </div>
                    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                        <span style="background:${colEst}20;color:${colEst};padding:4px 10px;border-radius:10px;font-size:12px;border:1px solid ${colEst}40;">
                            ${estado}
                        </span>
                        ${comp?.archivo_url
                            ? `<button class="btn-outline" style="padding:4px 10px;font-size:12px;" onclick="abrirArchivoRetencion('${comp.archivo_url}')">📄 Ver archivo</button>`
                            : ''}
                        ${estado !== 'Aprobado' ? `
                        <div style="display:flex;gap:6px;align-items:center;">
                            <input type="file" id="ret-file-${numFac}" accept=".pdf,.jpg,.jpeg,.png,.webp"
                                   style="font-size:11px;color:white;max-width:160px;">
                            <button class="btn-solid" style="padding:5px 10px;font-size:12px;background:#3b82f6;color:black;"
                                    onclick="subirComprobante('${numFac}','${estado}')">
                                ${estado === 'Rechazado' ? '🔄 Resubir' : '⬆ Subir'}
                            </button>
                        </div>` : ''}
                    </div>
                </div>
            </div>`;
        }

        container.innerHTML = html;
    }

    window.abrirArchivoRetencion = function(url) {
        if (url.toLowerCase().endsWith('.pdf')) {
            window.open(url, '_blank');
        } else {
            abrirModalSoporte(url);
        }
    };

    window.subirComprobante = async function(numFactura, estadoActual) {
        const fileEl = document.getElementById(`ret-file-${numFactura}`);
        if (!fileEl || !fileEl.files.length) return alert('Seleccione un archivo.');

        const file = fileEl.files[0];
        const ext  = file.name.split('.').pop().toLowerCase();
        const path = `${currentUser.id}/${numFactura}_${Date.now()}.${ext}`;

        showLoader('SUBIENDO COMPROBANTE DE RETENCIÓN...');
        try {
            const { error: upErr } = await supabase.storage
                .from('comprobantes_retencion')
                .upload(path, file, { contentType: file.type, upsert: true });
            if (upErr) throw upErr;

            const { data: urlData } = supabase.storage
                .from('comprobantes_retencion').getPublicUrl(path);

            // Calcular 75% del IVA de esta factura
            const fac = facturasGlobal[currentUser.id]?.[numFactura];
            const ivaTotal = fac?.ivaBs || 0;
            const montoRetener = ivaTotal * 0.75;

            const payload = {
                rif_cliente:     currentUser.id,
                num_factura:     numFactura,
                monto_retenido:  montoRetener,
                archivo_url:     urlData.publicUrl,
                fecha_subida:    new Date().toISOString().split('T')[0],
                estado:          'Cargado'
            };

            const { error: dbErr } = await supabase
                .from('comprobantes_retencion')
                .upsert(payload, { onConflict: 'rif_cliente,num_factura' });
            if (dbErr) throw dbErr;

            await loadClientRetenciones();
        } catch (err) {
            alert('Error al subir: ' + err.message);
        } finally { hideLoader(); }
    };


    // =========================================================
    // ▌MÓDULO 14: ADMIN — PANEL DE RETENCIONES
    // =========================================================

    async function loadAdminRetenciones() {
        const tbody = document.getElementById('admin-ret-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:rgba(255,255,255,0.4);padding:16px;">Cargando...</td></tr>';

        const { data, error } = await supabase
            .from('comprobantes_retencion')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(500);

        if (error || !data?.length) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:rgba(255,255,255,0.4);padding:16px;">No hay comprobantes registrados.</td></tr>';
            return;
        }

        tbody.innerHTML = '';
        data.forEach(c => {
            const colEst = c.estado === 'Aprobado' ? '#22c55e' : c.estado === 'Rechazado' ? '#ef4444' : '#eab308';
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="font-family:monospace;font-size:12px;">${c.rif_cliente}</td>
                <td>${c.num_factura}</td>
                <td class="font-serif" style="color:#c084fc;">Bs ${(parseFloat(c.monto_retenido) || 0).toFixed(2)}</td>
                <td>${c.fecha_subida || '-'}</td>
                <td>
                    <span style="background:${colEst}20;color:${colEst};padding:3px 8px;border-radius:10px;font-size:11px;border:1px solid ${colEst}40;">
                        ${c.estado}
                    </span>
                </td>
                <td style="font-size:12px;color:${c.procesado_por ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.25)'};">${c.procesado_por || '-'}</td>
                <td style="font-size:12px;color:rgba(255,255,255,0.5);">${c.fecha_procesado ? new Date(c.fecha_procesado).toLocaleDateString() : '-'}</td>
                <td style="font-size:12px;color:rgba(255,255,255,0.5);">${c.observacion_admin || '-'}</td>
            `;
            // Acciones
            const tdAcc = document.createElement('td');
            tdAcc.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;align-items:center;';

            if (c.archivo_url) {
                const bVer = document.createElement('button');
                bVer.className = 'btn-outline';
                bVer.style.cssText = 'padding:3px 8px;font-size:11px;';
                bVer.textContent = '📄 Ver';
                bVer.addEventListener('click', () => {
                    c.archivo_url.toLowerCase().endsWith('.pdf')
                        ? window.open(c.archivo_url, '_blank')
                        : abrirModalSoporte(c.archivo_url);
                });
                tdAcc.appendChild(bVer);
            }

            if (c.estado !== 'Aprobado') {
                const bAp = document.createElement('button');
                bAp.className = 'btn-solid';
                bAp.style.cssText = 'padding:3px 8px;font-size:11px;background:#22c55e;color:black;';
                bAp.textContent = '✓';
                bAp.title = 'Aprobar';
                bAp.addEventListener('click', () => procesarRetencion(c.id, 'Aprobado'));
                tdAcc.appendChild(bAp);
            }

            if (c.estado !== 'Rechazado') {
                const bRe = document.createElement('button');
                bRe.className = 'btn-solid';
                bRe.style.cssText = 'padding:3px 8px;font-size:11px;background:#ef4444;color:black;';
                bRe.textContent = '✕';
                bRe.title = 'Rechazar';
                bRe.addEventListener('click', () => {
                    const obs = prompt('Motivo del rechazo (opcional):', '');
                    procesarRetencion(c.id, 'Rechazado', obs || '');
                });
                tdAcc.appendChild(bRe);
            }

            tr.appendChild(tdAcc);
            tbody.appendChild(tr);
        });
    }
    window.loadAdminRetenciones = loadAdminRetenciones;

    async function procesarRetencion(id, nuevoEstado, observacion = '') {
        showLoader(`PROCESANDO RETENCIÓN (${nuevoEstado})...`);
        try {
            const { data, error } = await supabase.rpc('procesar_retencion', {
                p_id: id,
                p_nuevo_estado: nuevoEstado,
                p_observacion: observacion,
                p_admin_rif: currentUser.id || ''
            });

            if (error) throw error;
            if (!data?.success) throw new Error(data?.error || 'Error al procesar retención');

            await syncDataFromCloud();
            loadAdminRetenciones();
            loadDashboardStats();
        } catch (err) {
            alert('Error: ' + err.message);
        } finally { hideLoader(); }
    }


    // =========================================================
    // MÓDULO: TOUR GUIADO ONBOARDING
    // =========================================================
    const _tour = {
        overlay:       document.getElementById('tour-overlay'),
        highlight:     document.getElementById('tour-highlight'),
        counter:       document.getElementById('tour-counter'),
        title:         document.getElementById('tour-title'),
        text:          document.getElementById('tour-text'),
        progress:      document.getElementById('tour-progress'),
        nextBtn:       document.getElementById('tour-next-btn'),
        skipBtn:       document.getElementById('tour-skip-btn'),
        active:        false,
        steps:         null,
        stepIdx:       0,
        role:          null,
        _currentTarget: null,
        _scrollHandler: null
    };

    const tourStepsDef = {
        admin: [
            { target: '.navbar', title: 'Panel de Administración', text: 'Bienvenido al Portal de Cobranzas. Desde aquí gestionas toda la cartera de clientes, pagos y retenciones.' },
            { target: '#admin-tab-dashboard', tab: 'dashboard', title: 'Dashboard', text: 'Resumen general: cobros del mes, facturas pendientes, vencidas y próximas a vencer.' },
            { target: '#admin-tab-alertas', tab: 'alertas', title: 'Alertas', text: 'Facturas vencidas, próximas a vencer y pagos parciales activos que requieren atención.' },
            { target: '#admin-tab-buscador', tab: 'buscador', title: 'Buscador', text: 'Ingresa un RIF para consultar el perfil y la deuda de cualquier cliente.' },
            { target: '#admin-tab-pagos', tab: 'pagos', title: 'Pagos', text: 'Revisa, filtra, aprueba o rechaza pagos. Cada acción queda registrada para auditoría.' },
            { target: '#admin-tab-cartera', tab: 'cartera', title: 'Cartera', text: 'Importa el Excel con las facturas de los clientes. También puedes archivar facturas liquidadas con respaldo automático.' },
            { target: '#admin-tab-usuarios', tab: 'usuarios', title: 'Usuarios', text: 'Administra clientes, edita datos y marca quiénes son Agentes de Retención.' },
            { target: '#admin-tab-retenciones', tab: 'retenciones-admin', title: 'Retenciones', text: 'Revisa y aprueba los comprobantes de retención de IVA que suben los clientes.' }
        ],
        cliente: [
            { target: '.navbar', title: 'Portal de Cobranzas', text: 'Bienvenido. Aquí puedes revisar y pagar tus facturas de forma rápida y segura.' },
            { target: '#invoices-container', tab: 'estado-cuenta', title: 'Estado de Cuenta', text: 'Estas son tus facturas pendientes por pagar. Revisa los montos y las fechas de vencimiento.' },
            { target: '.factura-abono-input', tab: 'estado-cuenta', title: 'Abono por Factura', text: 'Escribe aquí cuánto deseas abonar a cada factura. Puedes pagar varias facturas en un solo pago.' },
            { target: '#total-amount', tab: 'estado-cuenta', title: 'Total a Pagar', text: 'El total a pagar se calcula automáticamente según los abonos que ingreses.' },
            { target: '#pago-metodo', tab: 'estado-cuenta', title: 'Método de Pago', text: 'Elige tu método de pago.' },
            { target: '#pago-ref', tab: 'estado-cuenta', title: 'Referencia', text: 'Ingresa el número de referencia de tu transferencia o pago.' },
            { target: '#pago-date', tab: 'estado-cuenta', title: 'Fecha de Pago', text: 'Selecciona la fecha en que realizaste el pago.' },
            { target: '#pago-soporte', tab: 'estado-cuenta', title: 'Comprobante', text: 'Sube una foto o captura de pantalla del comprobante de pago.' },
            { target: '#btn-submit-payment', tab: 'estado-cuenta', title: 'Enviar Pago', text: 'Envía tu pago. El administrador lo revisará y lo aprobará.' },
            { target: '#client-tab-historial', tab: 'historial', title: 'Historial de Pagos', text: 'Todos tus pagos registrados con su estado actual (Pendiente, Aprobado, Rechazado).' },
            { target: '#client-tab-iva', tab: 'iva', title: 'Pago de IVA', text: 'Aquí puedes pagar el IVA de tus facturas en bolívares.' },
            { target: '#iva-invoices-container', tab: 'iva', title: 'Facturas con IVA', text: 'Selecciona las facturas para las que deseas pagar el IVA.' },
            { target: '#iva-total-amount', tab: 'iva', title: 'Total IVA', text: 'El total de IVA a pagar se calcula automáticamente.' },
            { target: '#iva-pago-metodo', tab: 'iva', title: 'Método de Pago - IVA', text: 'Elige el método de pago para el IVA.' },
            { target: '#btn-submit-iva-payment', tab: 'iva', title: 'Enviar Pago IVA', text: 'Envía el pago de IVA. El administrador lo revisará.' },
            { target: '#client-tab-retenciones', tab: 'retenciones', title: 'Comprobantes de Retención', text: 'Si eres Agente de Retención, sube aquí tu comprobante para descontar el IVA.' },
            { target: ':retencion-card', tab: 'retenciones', title: 'Seleccionar Archivo', text: 'Por cada factura, selecciona el archivo del comprobante de retención.' },
            { target: ':retencion-btn', tab: 'retenciones', title: 'Subir Comprobante', text: 'Haz clic para subir el comprobante. Una vez aprobado, se descontará de tu IVA.' }
        ]
    };

    function _tourFindEl(sel) {
        if (sel === '.factura-abono-input') return document.querySelector('.factura-abono-input');
        if (sel === ':retencion-card') {
            const c = document.getElementById('retenciones-container');
            return c ? c.querySelector('.card.liquid-glass') : null;
        }
        if (sel === ':retencion-btn') {
            const c = document.getElementById('retenciones-container');
            return c ? c.querySelector('.btn-solid') : null;
        }
        return document.querySelector(sel);
    }

    function _tourReposition() {
        const el = _tour._currentTarget;
        if (!el || el.offsetParent === null) return;
        const rect = el.getBoundingClientRect();
        _tour.highlight.style.top    = rect.top + 'px';
        _tour.highlight.style.left   = rect.left + 'px';
        _tour.highlight.style.width  = rect.width + 'px';
        _tour.highlight.style.height = rect.height + 'px';
    }

    function _tourShow(idx) {
        const steps = _tour.steps;
        const step = steps[idx];
        const el = _tourFindEl(step.target);
        const total = steps.length;
        const tooltipEl = _tour.nextBtn.parentElement.parentElement;

        // remover scroll handler anterior
        if (_tour._scrollHandler) {
            window.removeEventListener('scroll', _tour._scrollHandler, { passive: true });
            window.removeEventListener('resize', _tour._scrollHandler, { passive: true });
            _tour._scrollHandler = null;
        }
        _tour._currentTarget = null;

        if (el && el.offsetParent !== null) {
            const rect = el.getBoundingClientRect();
            _tour.highlight.style.display = 'block';
            _tour.highlight.style.top    = rect.top + 'px';
            _tour.highlight.style.left   = rect.left + 'px';
            _tour.highlight.style.width  = rect.width + 'px';
            _tour.highlight.style.height = rect.height + 'px';
            _tour.highlight.classList.add('pulse');
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });

            const tw = Math.min(400, window.innerWidth * 0.94);
            const spB = window.innerHeight - (rect.bottom + 16);
            const spA = rect.top - 16;
            let tTop  = spB > 300 || spB >= spA ? rect.bottom + 16 : Math.max(10, rect.top - 300);
            let tLeft = Math.max(10, Math.min(rect.left + rect.width/2 - tw/2, window.innerWidth - tw - 10));
            tooltipEl.style.width = tw + 'px';
            tooltipEl.style.top   = tTop + 'px';
            tooltipEl.style.left  = tLeft + 'px';

            // guardar target y escuchar scroll/reize para mantener highlight fijo sobre el elemento
            _tour._currentTarget = el;
            _tour._scrollHandler = () => _tourReposition();
            window.addEventListener('scroll', _tour._scrollHandler, { passive: true });
            window.addEventListener('resize', _tour._scrollHandler, { passive: true });
        } else {
            _tour.highlight.style.display = 'none';
            tooltipEl.style.width  = Math.min(400, window.innerWidth * 0.94) + 'px';
            tooltipEl.style.top    = '120px';
            tooltipEl.style.left   = '50%';
            tooltipEl.style.marginLeft = (-Math.min(400, window.innerWidth * 0.94)/2) + 'px';
        }

        _tour.counter.textContent  = 'PASO ' + (idx + 1) + '/' + total;
        _tour.title.textContent    = step.title;
        _tour.text.textContent     = step.text;
        _tour.progress.textContent = 'Paso ' + (idx + 1) + ' de ' + total;
        _tour.nextBtn.textContent  = idx === total - 1 ? 'Finalizar ✓' : 'Siguiente →';
    }

    function _tourGoTo(idx) {
        if (idx >= _tour.steps.length) { _tourEnd(); return; }
        _tour.stepIdx = idx;
        const step = _tour.steps[idx];
        if (step.tab) {
            try {
                if (_tour.role === 'admin') {
                    if (window.switchAdminTab) window.switchAdminTab(step.tab);
                } else {
                    if (window.switchClientTab) window.switchClientTab(step.tab);
                }
            } catch(e) { /* pestanya no disponible para este usuario */ }
        }
        let retries = 15;
        function attempt() {
            const el = _tourFindEl(step.target);
            if ((!el || el.offsetParent === null) && retries > 0) {
                retries--;
                setTimeout(attempt, 250);
                _tourShow(idx);
            } else {
                _tourShow(idx);
            }
        }
        setTimeout(attempt, 300);
    }

    function _tourEnd() {
        if (!_tour.active) return;
        _tour.active = false;
        _tour.overlay.classList.remove('active', 'hidden');
        _tour.highlight.style.display = 'none';
        if (_tour._scrollHandler) {
            window.removeEventListener('scroll', _tour._scrollHandler);
            window.removeEventListener('resize', _tour._scrollHandler);
            _tour._scrollHandler = null;
        }
        _tour._currentTarget = null;
        try { localStorage.setItem('tour_' + currentUser.id, '1'); } catch(e) {}
        _tour.nextBtn.removeEventListener('click', _tour._nextHandler);
        _tour.skipBtn.removeEventListener('click', _tour._skipHandler);
    }

    function tourStart(role) {
        if (_tour.active) return;
        let steps = tourStepsDef[role];
        if (!steps || !steps.length) return;
        // filtrar pasos de retencion si el usuario no es Agente de Retencion
        if (role === 'cliente' && !currentUser.esAgenteRetencion) {
            steps = steps.filter(s => s.target !== '#client-tab-retenciones' && s.target !== ':retencion-card' && s.target !== ':retencion-btn');
        }
        _tour.active = true;
        _tour.steps  = steps;
        _tour.role   = role;
        _tour.stepIdx = 0;
        _tour.overlay.classList.remove('hidden');
        _tour.overlay.classList.add('active');

        // quitar handlers previos si existen
        if (_tour._nextHandler) _tour.nextBtn.removeEventListener('click', _tour._nextHandler);
        if (_tour._skipHandler) _tour.skipBtn.removeEventListener('click', _tour._skipHandler);

        _tour._nextHandler = () => _tourGoTo(_tour.stepIdx + 1);
        _tour._skipHandler = () => _tourEnd();

        _tour.nextBtn.addEventListener('click', _tour._nextHandler);
        _tour.skipBtn.addEventListener('click', _tour._skipHandler);

        _tourGoTo(0);
    }

    window.iniciarTour = function(role) {
        const already = localStorage.getItem('tour_' + currentUser.id);
        if (already) return;
        setTimeout(() => tourStart(role), 600);
    };


});