router.post("/finales", async (req, res) => {
  try {
    const { subject_id, exam_type, modalidad } = req.body;

    // Buscar materia por ID para traer el nombre y año
    const materia = await db.query("SELECT name, year FROM subjects WHERE id = ?", [subject_id]);

    // Guardar en la tabla de finales
    await db.query(
      "INSERT INTO finales (subject_id, exam_type, modalidad) VALUES (?, ?, ?)",
      [subject_id, exam_type, modalidad]
    );

    // Responder con JSON para el frontend
    res.json({
      subject_name: materia[0].name,
      year: materia[0].year,
      exam_type,
      modalidad
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al guardar final" });
  }
});