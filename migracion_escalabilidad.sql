-- ============================================================
-- MIGRACIÓN: ESCALABILIDAD + TRAZA DE AUDITORÍA
-- Ejecutar en el SQL Editor de Supabase (dashboard)
-- ============================================================

-- ⚠️ NOTA: RLS requiere Supabase Auth (Fase 2). Por ahora NO
--    habilitar RLS. La seguridad se maneja a nivel código.

-- ── 1. COLUMNAS DE TRAZA (AUDITORÍA) ───────────────────────

ALTER TABLE pagos ADD COLUMN IF NOT EXISTS procesado_por TEXT;
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS fecha_procesado TIMESTAMPTZ;
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS observacion_admin TEXT;

ALTER TABLE comprobantes_retencion ADD COLUMN IF NOT EXISTS procesado_por TEXT;
ALTER TABLE comprobantes_retencion ADD COLUMN IF NOT EXISTS fecha_procesado TIMESTAMPTZ;


-- ── 2. FUNCIÓN RPC: procesarPago (transaccional + traza) ──

CREATE OR REPLACE FUNCTION procesar_pago(
    p_id TEXT,
    p_nuevo_estado TEXT,
    p_admin_rif TEXT DEFAULT '',
    p_observacion TEXT DEFAULT ''
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_pago RECORD;
    v_item RECORD;
    v_fac RECORD;
    v_nuevo_saldo NUMERIC;
BEGIN
    SELECT * INTO v_pago FROM pagos WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Pago no encontrado');
    END IF;

    IF p_nuevo_estado = 'Aprobado' THEN
        FOR v_item IN SELECT * FROM jsonb_to_recordset(v_pago.desglose_pagado)
                      AS x(factura TEXT, concepto TEXT, monto NUMERIC)
        LOOP
            IF v_item.factura IS NULL THEN CONTINUE; END IF;

            SELECT * INTO v_fac
            FROM facturas_saldos
            WHERE rif_cliente = v_pago.rif_cliente AND num_factura = v_item.factura
            FOR UPDATE;

            IF NOT FOUND THEN CONTINUE; END IF;

            IF v_pago.tipo_pago = 'iva' OR v_item.concepto = 'IVA' THEN
                v_nuevo_saldo := GREATEST(0, v_fac.iva_bs - v_item.monto);
                UPDATE facturas_saldos SET iva_bs = v_nuevo_saldo
                WHERE rif_cliente = v_pago.rif_cliente AND num_factura = v_item.factura;
            ELSE
                v_nuevo_saldo := GREATEST(0, v_fac.abierto_usd - v_item.monto);
                UPDATE facturas_saldos SET abierto_usd = v_nuevo_saldo
                WHERE rif_cliente = v_pago.rif_cliente AND num_factura = v_item.factura;
            END IF;
        END LOOP;
    END IF;

    UPDATE pagos SET
        status = p_nuevo_estado,
        procesado_por = CASE WHEN p_nuevo_estado IN ('Aprobado','Rechazado') THEN p_admin_rif ELSE procesado_por END,
        fecha_procesado = CASE WHEN p_nuevo_estado IN ('Aprobado','Rechazado') THEN NOW() ELSE fecha_procesado END,
        observacion_admin = CASE WHEN p_nuevo_estado = 'Rechazado' THEN p_observacion ELSE observacion_admin END
    WHERE id = p_id;

    RETURN jsonb_build_object('success', true);
END;
$$;


-- ── 3. FUNCIÓN RPC: procesarRetencion (transaccional + traza)

CREATE OR REPLACE FUNCTION procesar_retencion(
    p_id BIGINT,
    p_nuevo_estado TEXT,
    p_observacion TEXT DEFAULT '',
    p_admin_rif TEXT DEFAULT ''
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_comp RECORD;
    v_fac RECORD;
    v_nuevo_iva NUMERIC;
BEGIN
    SELECT * INTO v_comp FROM comprobantes_retencion WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Comprobante no encontrado');
    END IF;

    IF p_nuevo_estado = 'Aprobado' THEN
        SELECT * INTO v_fac
        FROM facturas_saldos
        WHERE rif_cliente = v_comp.rif_cliente AND num_factura = v_comp.num_factura
        FOR UPDATE;

        IF FOUND THEN
            v_nuevo_iva := GREATEST(0, v_fac.iva_bs - v_comp.monto_retenido);
            UPDATE facturas_saldos SET iva_bs = v_nuevo_iva
            WHERE rif_cliente = v_comp.rif_cliente AND num_factura = v_comp.num_factura;
        END IF;
    END IF;

    UPDATE comprobantes_retencion
    SET estado = p_nuevo_estado,
        observacion_admin = CASE WHEN p_nuevo_estado = 'Rechazado' THEN p_observacion ELSE observacion_admin END,
        procesado_por = CASE WHEN p_nuevo_estado IN ('Aprobado','Rechazado') THEN p_admin_rif ELSE procesado_por END,
        fecha_procesado = CASE WHEN p_nuevo_estado IN ('Aprobado','Rechazado') THEN NOW() ELSE fecha_procesado END
    WHERE id = p_id;

    RETURN jsonb_build_object('success', true);
END;
$$;


-- ── 4. FUNCIÓN RPC: archivarFacturasLote (batch delete por lote) ──

CREATE OR REPLACE FUNCTION archivar_facturas_lote(
    p_facturas JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_item RECORD;
    v_count INT := 0;
BEGIN
    FOR v_item IN SELECT * FROM jsonb_to_recordset(p_facturas)
                  AS x(rif_cliente TEXT, num_factura TEXT)
    LOOP
        DELETE FROM pagos
        WHERE rif_cliente = v_item.rif_cliente
          AND (num_factura LIKE '%' || v_item.num_factura || '%'
               OR desglose_pagado @> jsonb_build_array(jsonb_build_object('factura', v_item.num_factura)));

        DELETE FROM facturas_saldos
        WHERE rif_cliente = v_item.rif_cliente AND num_factura = v_item.num_factura;

        v_count := v_count + 1;
    END LOOP;

    RETURN jsonb_build_object('success', true, 'archivadas', v_count);
END;
$$;


-- ── 5. ÍNDICES PARA RENDIMIENTO ────────────────────────────

CREATE INDEX IF NOT EXISTS idx_facturas_rif ON facturas_saldos (rif_cliente);
CREATE INDEX IF NOT EXISTS idx_facturas_abierto ON facturas_saldos (abierto_usd);
CREATE INDEX IF NOT EXISTS idx_pagos_rif ON pagos (rif_cliente);
CREATE INDEX IF NOT EXISTS idx_pagos_status ON pagos (status);
CREATE INDEX IF NOT EXISTS idx_pagos_created ON pagos (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pagos_procesado ON pagos (fecha_procesado DESC);
CREATE INDEX IF NOT EXISTS idx_usuarios_rol ON usuarios (rol);
CREATE INDEX IF NOT EXISTS idx_comprobantes_rif ON comprobantes_retencion (rif_cliente);
CREATE INDEX IF NOT EXISTS idx_comprobantes_estado ON comprobantes_retencion (estado);
CREATE INDEX IF NOT EXISTS idx_comprobantes_procesado ON comprobantes_retencion (fecha_procesado DESC);
