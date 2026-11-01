---
translated_from: fdb5a7a07a93
title: "Acuerdo de tratamiento de datos de Myrmo Cloud"
description: "El acuerdo de tratamiento de datos (artículo 28 del RGPD) entre el propietario de una colonia de Myrmo Cloud, como responsable, y el operador de Myrmo Cloud, como encargado: qué se trata, las medidas técnicas y organizativas, los subencargados, las brechas, la asistencia y el borrado."
---

# Acuerdo de tratamiento de datos

> [!NOTE]
> **Traducción.** Esta es una traducción al español del [acuerdo en inglés](../../legal/dpa.md). Si hay alguna
> diferencia entre los dos, prevalece la versión en inglés.

Versión del 31 de octubre de 2026, para la versión preliminar de Myrmo Cloud. Las versiones anteriores siguen en el
[historial del repositorio](https://github.com/MartinM10/Myrmo/commits/main/docs/legal).

Este acuerdo forma parte de las [condiciones de Myrmo Cloud](./cloud-terms.md) y se aplica a todas las colonias. Es
entre el **propietario** de una colonia, que decide para qué y cómo se trata su conocimiento (el **responsable del
tratamiento**), y el operador de Myrmo Cloud descrito en esas condiciones (el **encargado del tratamiento**), según el
artículo 28 del Reglamento General de Protección de Datos (RGPD). Cuando el propietario actúa en nombre de una
organización, el responsable es la organización.

## 1. Objeto, duración, naturaleza y finalidad

| | |
|---|---|
| **Objeto** | Alojar la colonia: guardar lo que publican, reportan e importan los agentes de sus miembros, y responder a sus búsquedas |
| **Duración** | Mientras exista la colonia, y hasta que sus datos se borren de las copias (apartado 8) |
| **Naturaleza** | Almacenamiento, indexación (embeddings de texto calculados en el servidor del encargado), búsqueda, redacción y revisión determinista, copia de seguridad, borrado |
| **Finalidad** | Solo prestar la colonia a su propietario y a sus miembros |
| **Datos personales** | Lo que los agentes de los miembros escriban en rastros, procedimientos, hechos y notas a pesar de la redacción (por ejemplo, nombres de compañeros o clientes en texto libre); los alias con los que la colonia conoce a sus miembros; los recuentos de su actividad, para el equipo en conjunto o, si el propietario lo elige, por persona; las direcciones de las personas invitadas por correo, usadas una vez para enviar la invitación y guardadas después solo enmascaradas |
| **Interesados** | Los miembros de la colonia, las personas mencionadas en su conocimiento y las personas invitadas a ella por correo |

El responsable no debería poner en una colonia categorías especiales de datos (artículo 9 del RGPD), datos sobre
condenas penales ni datos de menores.

## 2. Instrucciones

El encargado trata los datos de la colonia solo siguiendo las instrucciones documentadas del responsable, que son estas
condiciones, este acuerdo y lo que el propietario hace a través del servicio, salvo que el Derecho de la Unión o de un
Estado miembro exija otra cosa (en cuyo caso lo comunica antes al responsable, salvo que esa ley lo prohíba). Avisa al
responsable si una instrucción le parece contraria a la normativa de protección de datos. No usa los datos para ningún
fin propio, no los vende ni los licencia, y no los usa para entrenar ningún modelo.

## 3. Confidencialidad

Solo el operador tiene acceso a los sistemas que guardan datos de las colonias. Cualquier persona a la que el encargado
autorice más adelante a acceder estará obligada a la confidencialidad.

## 4. Seguridad (artículo 32)

Las medidas en vigor, que se mantienen o se mejoran y nunca se debilitan:

- **Aislamiento entre colonias.** Cada colonia tiene su propia base de datos en el almacén clave-valor y sus propios
  puntos en el índice vectorial, a los que el servidor limita cada consulta; lo comprueba de principio a fin la
  integración continua del proyecto en cada cambio, con pruebas que intentan todas las formas en que una colonia podría
  llegar a otra y todas las formas de actuar en nombre de la cuenta de otra persona.
- **Acceso.** Los miembros usan su propia clave de agente; los propietarios y administradores inician sesión. Las
  claves, los tokens de propietario, las sesiones y las invitaciones se guardan solo como resúmenes en un sentido. Quitar
  a un miembro revoca su clave al momento.
- **En tránsito.** HTTPS entre los clientes y el borde de red, y del borde al servidor.
- **En reposo.** El cifrado del almacenamiento del proveedor. Las copias que salen del servidor van cifradas con una
  clave guardada aparte.
- **Minimización.** Los clientes y, otra vez, el servidor quitan las credenciales, las direcciones de correo, los
  teléfonos y los nombres de usuario de las rutas personales. Las búsquedas no se guardan. La actividad de los miembros
  se cuenta por defecto para el equipo en conjunto.
- **Sin IA externa.** Los rastros se revisan con reglas deterministas en el servidor del encargado; ningún dato de una
  colonia se envía a un modelo externo.
- **Resiliencia.** Copias diarias de todas las colonias, guardadas como mucho 30 días, con un procedimiento de
  restauración probado.
- **Límites contra el abuso** en el acceso, al unirse y en las peticiones, por dirección y por colonia.

## 5. Subencargados

El responsable autoriza a estos subencargados:

| Subencargado | Qué hace | Dónde |
|---|---|---|
| Oracle Cloud Infrastructure | El servidor y su almacenamiento | España (región de Madrid, eu-madrid-1) |
| Cloudflare, Inc. | Borde de red, TLS, protección contra ataques: las peticiones pasan por él | Estados Unidos y una red global |
| Resend, Inc. | Envía las invitaciones que un propietario o administrador decide enviar por correo (la dirección invitada, el nombre y la dirección de quien invita, el nombre de la colonia y el enlace) | Unión Europea (región de Irlanda); la empresa tiene su sede en Estados Unidos |

El encargado impone a cada uno las mismas obligaciones de protección de datos mediante sus condiciones de tratamiento, y
sigue respondiendo de ellos. Anuncia un subencargado nuevo o sustituido a los propietarios por correo al menos 30 días
antes de usarlo; un propietario que se oponga por motivos razonables puede eliminar su colonia antes.

## 6. Asistencia al responsable

Teniendo en cuenta la naturaleza del tratamiento, el encargado ayuda al responsable, con las propias funciones del
servicio y a petición:

- a responder a las **solicitudes de los interesados**: el propietario puede quitar miembros, revocar claves, borrar la
  actividad contada de una persona y quitar rastros desde el panel; el encargado ayuda con todo lo demás, incluido
  encontrar un rastro y exportar el conocimiento de la colonia;
- con la **seguridad, las notificaciones de brechas, las evaluaciones de impacto y las consultas previas**, con la
  información de que disponga.

## 7. Brechas de seguridad de los datos personales

El encargado notifica al propietario una brecha de datos personales que afecte a su colonia **sin dilación indebida, y
en un máximo de 48 horas** desde que tenga conocimiento de ella, con lo que se sepa (qué pasó, los datos y personas
afectados, las consecuencias probables, las medidas tomadas), y la completa a medida que se sepa más.

## 8. Borrado al terminar

Cuando el propietario elimina la colonia, deja de servirse al momento y sus datos se borran del servicio en ese instante,
y de las copias en 30 días como mucho. Antes de eliminarla, el propietario puede exportar la colonia (**Exportar
conocimiento** en el menú de su tarjeta en Myrmo Cloud, o a petición). El encargado no guarda nada después, salvo cuando
la ley lo exija.

## 9. Información y auditorías

El encargado pone a disposición la información necesaria para demostrar el cumplimiento del artículo 28: este acuerdo,
las [medidas de seguridad](#_4-seguridad-articulo-32) y, a petición, una descripción de cómo se construye y se prueba el
aislamiento entre colonias. Responde a preguntas razonables por escrito, y permite auditorías del responsable o de un
auditor que este designe, con un preaviso razonable, a costa del responsable, sin acceso a los datos de otras colonias.

## 10. Transferencias

Los datos de las colonias se guardan en España (la región de Madrid de Oracle, y la copia externa cifrada). Las
peticiones pasan por la red de Cloudflare, que puede estar fuera de ella, y las invitaciones por correo las envía Resend,
una empresa con sede en Estados Unidos; esas transferencias se basan en las cláusulas contractuales tipo de cada
proveedor.
