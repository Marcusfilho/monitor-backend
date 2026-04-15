// =============================================================================
// PATCH: jobRoutes.ts — encadear html5_change_company após html5_install
// =============================================================================
// INSTRUÇÕES:
//   Encontre a função que é chamada quando um job é completado (completeJob ou
//   equivalente) em jobRoutes.ts. Dentro dela, logo APÓS o job ser marcado como
//   completed, adicione o bloco abaixo.
//
//   Grep para achar o ponto certo:
//     grep -n "html5_install\|completeJob\|job\.type\|job\.status.*completed" \
//       src/routes/jobRoutes.ts
// =============================================================================

// ---------------------------------------------------------------------------
// Trecho a adicionar em jobRoutes.ts
// Ponto de inserção: dentro do handler POST /api/jobs/:id/complete (ou equivalente),
// logo após o job ser marcado como "completed".
// ---------------------------------------------------------------------------

// ---- INÍCIO DO TRECHO A COLAR ----

// Encadeamento: após html5_install com confirmed_change_company, enfileira html5_change_company
if (
  job.type === "html5_install" &&
  job.status === "completed" &&
  (job.payload?.confirmed_change_company === true ||
    job.payload?.confirmed_change_company === "true" ||
    job.payload?.confirmed_change_company === "True")
) {
  console.log(
    `[jobRoutes] html5_install completou com confirmed_change_company=true ` +
    `— enfileirando html5_change_company para installation_id=${job.payload?.installation_id}`
  );

  // Campos obrigatórios para o changeCompany job
  const ccPayload = {
    flow: "CHANGE_COMPANY",
    vehicle_id:
      job.payload?.vehicle_id_final ??
      job.payload?.vehicle_id ??
      job.payload?.VEHICLE_ID ??
      job.payload?.vehicleId,
    plate_real:
      job.payload?.plate_real ??
      job.payload?.plate ??
      job.payload?.LICENSE_NMBR,
    client_descr:
      job.payload?.client_descr ??
      job.payload?.clientName ??
      job.payload?.client_name,
    installation_id: job.payload?.installation_id,
  };

  // Validação básica antes de enfileirar
  if (!ccPayload.vehicle_id || !ccPayload.plate_real || !ccPayload.client_descr) {
    console.error(
      `[jobRoutes] html5_change_company NÃO enfileirado — campos faltando:`,
      ccPayload
    );
  } else {
    // Use a função de enfileirar já existente no projeto
    // Substitua "enqueueJob" pelo nome real da função no seu jobRoutes.ts
    // Ex: createJob, addJob, jobStore.create, etc.
    await enqueueJob("html5_change_company", ccPayload);
    console.log(
      `[jobRoutes] html5_change_company enfileirado com sucesso:`,
      ccPayload
    );
  }
}

// ---- FIM DO TRECHO A COLAR ----

// =============================================================================
// REFERÊNCIA — como enqueueJob pode estar implementado no seu projeto:
// =============================================================================
//
// Se no seu jobRoutes.ts o job é criado com algo como:
//
//   const newJob = jobStore.create({ type, payload, status: "queued" });
//
// Então substitua "await enqueueJob(...)" por:
//
//   const ccJob = jobStore.create({
//     type: "html5_change_company",
//     payload: ccPayload,
//     status: "queued",
//   });
//   console.log(`[jobRoutes] html5_change_company criado: id=${ccJob.id}`);
//
// Grep para achar o padrão exato:
//   grep -n "jobStore\|createJob\|enqueueJob\|status.*queued" src/routes/jobRoutes.ts | head -20
// =============================================================================
