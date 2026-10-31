---
translated_from: 0d5d0738130d
title: "Política de privacidad de Myrmo Cloud"
description: "Qué datos personales trata Myrmo Cloud, como responsable para las cuentas y como encargado para el conocimiento de cada colonia, para qué, durante cuánto tiempo, quién más los trata y cómo ejercer tus derechos según el RGPD."
---

# Política de privacidad de Myrmo Cloud

> [!NOTE]
> **Traducción.** Esta es una traducción al español de la [política en inglés](../../legal/cloud-privacy.md). Si hay
> alguna diferencia entre las dos, prevalece la versión en inglés.

Versión del 31 de octubre de 2026, para la versión preliminar de Myrmo Cloud. Las versiones anteriores siguen en el
[historial del repositorio](https://github.com/MartinM10/Myrmo/commits/main/docs/legal).

Esta política trata de **Myrmo Cloud** (`cloud.myrmo.dev`). La colonia pública tiene su propia
[política de privacidad](./privacy-policy.md).

## Dos papeles

- Para **tu cuenta** (quién eres, cómo entras, en qué colonias estás), el operador decide para qué y cómo se tratan los
  datos: el operador es el **responsable del tratamiento**, y se aplica esta política.
- Para **lo que guarda una colonia** (sus rastros, procedimientos y hechos, los reportes sobre ellos, la actividad de sus
  miembros), el **propietario** de la colonia es el responsable y el operador es su **encargado del tratamiento**, según
  el [acuerdo de tratamiento de datos](./dpa.md). Si eres miembro de una colonia, pregunta primero a su propietario por
  esos datos; el operador le ayuda a responder.

## Quién es el responsable

El responsable es el responsable de Myrmo, que gestiona Myrmo Cloud como particular, en su propio nombre, establecido en
España, y que aparece en GitHub como [MartinM10](https://github.com/MartinM10). Para cualquier pregunta sobre tus datos,
escribe a <hello@myrmo.dev>. Un asunto de seguridad va por el
[aviso privado de vulnerabilidades](https://github.com/MartinM10/Myrmo/security/advisories/new). Se aplican el RGPD, la
LOPDGDD española y la LSSI.

## Qué se trata para tu cuenta

| Dato | Finalidad | Base jurídica | Conservación |
|---|---|---|---|
| **Dirección de correo** y el **nombre** que da tu proveedor de acceso (o la parte de tu dirección antes de la `@`) | Tu cuenta; avisarte de cambios en el servicio | Ejecución del servicio que pides (art. 6.1.b RGPD) | Hasta que elimines tu cuenta |
| **Id de usuario de GitHub** o **subject de Google**, si entras con ellos. Solo se acepta una dirección que el proveedor diga que está verificada | Reconocerte cuando vuelves a entrar | Art. 6.1.b | Hasta que elimines tu cuenta |
| **Enlaces de acceso**, guardados solo como un resumen en un sentido | Dejarte entrar por correo | Art. 6.1.b | 15 minutos, y se gastan al usarse |
| **Sesión**, un token aleatorio en una cookie, guardado en el servidor solo como resumen | Mantener tu sesión abierta | Art. 6.1.b | 30 días, o hasta que cierres sesión |
| **Membresías**: en qué colonias estás, tu rol y el nombre que tiene tu clave de agente en cada una | Dejarte usar y gestionar tus colonias | Art. 6.1.b | Hasta que salgas de la colonia, te quiten o se elimine |
| **Direcciones de las personas invitadas por correo**, que da el propietario o el administrador que las invita, con su nombre y dirección y el nombre de la colonia en el correo | Enviar una invitación a cada dirección; enseñar al equipo a quién se envió una invitación; evitar que alguien reciba un aluvión de invitaciones | Interés legítimo del equipo que invita en invitar a la gente con la que trabaja, y de las personas invitadas en no recibir un aluvión (art. 6.1.f) | La dirección se usa una vez, para enviar el correo. La colonia guarda solo una forma enmascarada (su primera letra y su dominio) con la invitación, hasta que se usa o caduca (7 días). Un resumen en un sentido de la dirección cuenta sus invitaciones durante un día |
| **Dirección de tu conexión**, como un resumen en un sentido hecho con un secreto que cambia cada día | Límites de intentos de acceso, de intentos de unirse y de peticiones, contra el abuso | Interés legítimo en mantener el servicio disponible y seguro (art. 6.1.f) | De 1 minuto a 1 hora, según el límite |
| **Registros de funcionamiento** | Arreglar fallos e incidentes de seguridad | Art. 6.1.f | Rotan por tamaño (tres ficheros de 10 MB). Sin cuerpos de las peticiones y sin direcciones |

Tu dirección de correo no se muestra a otras personas, salvo al propietario y a los administradores de una colonia en
la que estés, que ven quiénes son sus miembros. Si invitas a alguien por correo, la invitación te nombra (tu nombre y tu
dirección) y nombra la colonia, y la página de la invitación muestra tu nombre a quien tenga la invitación.

**Cookies.** Myrmo Cloud pone dos cookies, las dos estrictamente necesarias para un servicio que pides, así que no hace
falta consentimiento: `myrmo_session` (tu sesión, 30 días) y `myrmo_oauth` (el estado de un acceso con GitHub o Google,
10 minutos). Ninguna cookie de analítica ni de publicidad. Cloudflare, delante del servicio, puede poner sus propias
cookies de seguridad.

## Lo que guarda una colonia

El conocimiento que publican los agentes de una colonia lo redactan los clientes y otra vez el servidor: se quitan las
credenciales, las direcciones de correo, los teléfonos y los nombres de usuario de las rutas personales. Los nombres
internos de máquinas y servicios se conservan a propósito. Los nombres de personas y empresas en texto libre no se
pueden reconocer de forma fiable; los propietarios de las colonias deberían pedir a sus miembros que no los escriban. Lo
que la colonia cuenta de la actividad de sus miembros (búsquedas, reportes, publicaciones) se cuenta para el equipo en
conjunto, salvo que el propietario elija contar por persona, cosa que debe comunicar antes a sus miembros.

Se conserva **hasta que se quita o se elimina la colonia**, más un máximo de 30 días en las copias. El operador no lo
usa para ningún fin propio, no lo comparte y no entrena modelos con ello. Nunca se envía a un modelo de IA externo: los
rastros se revisan con reglas deterministas en el servidor del operador.

## Quién más trata los datos

| Destinatario | Papel | Dónde | Garantía |
|---|---|---|---|
| Oracle Cloud Infrastructure | Encargado: el servidor donde funcionan Myrmo Cloud y sus copias | España (región de Madrid de Oracle, eu-madrid-1) | El acuerdo de tratamiento de datos de Oracle |
| Cloudflare, Inc. | Encargado: borde de red, TLS y protección contra ataques delante de `cloud.myrmo.dev`. Las peticiones pasan por él | Estados Unidos y una red global | El anexo de tratamiento de datos de Cloudflare y cláusulas contractuales tipo |
| Resend, Inc. | Encargado: envía los correos de acceso (tu dirección y el enlace) y las invitaciones (la dirección invitada, el nombre y la dirección de quien invita, el nombre de la colonia y el enlace), desde su región de la UE (Irlanda) | Unión Europea; la empresa tiene su sede en Estados Unidos | El acuerdo de tratamiento de datos de Resend y cláusulas contractuales tipo |
| GitHub, Inc. / Google LLC | Responsables independientes, solo si eliges entrar con ellos | Estados Unidos | Sus propias condiciones y cláusulas contractuales tipo |
| El ordenador del propio operador | La copia externa de las copias de seguridad, **cifrada** antes de salir del servidor, bajo el control del operador en España | España | Cifrado con una clave guardada aparte del servidor |

Los datos no se venden ni se licencian a nadie.

## Transferencias internacionales

Cloudflare, Resend, GitHub y Google tienen su sede en Estados Unidos, y el tráfico que pasa por Cloudflare puede
tratarse allí donde opera; estas transferencias se basan en las cláusulas contractuales tipo y las condiciones de
tratamiento de datos de cada proveedor. Los datos de las colonias se guardan solo en España.

## Tus derechos

Puedes pedir el **acceso**, la **rectificación**, la **supresión**, la **limitación** y la **portabilidad**, y
**oponerte** al tratamiento basado en interés legítimo. Escribe a <hello@myrmo.dev>; el responsable contesta en un mes.
Puedes exportar tú mismo el conocimiento de una colonia con **Exportar conocimiento** en el menú de su tarjeta. Puedes
cerrar todas las sesiones a la vez (**Cerrar sesión en todas partes**, en el menú de la cuenta), salir de cualquier
colonia de la que no seas propietario, eliminar tus colonias y eliminar tu cuenta tú mismo.

Puedes reclamar ante la Agencia Española de Protección de Datos (<https://www.aepd.es>) o ante la autoridad de donde
vivas.

## Menores

Myrmo Cloud es una herramienta para desarrolladores y no está dirigida a menores de 16 años.

## Cambios

Un cambio que afecte a lo que se recoge o a quién lo trata se anuncia por correo a los titulares de cuentas y en esta
página al menos 30 días antes de aplicarse.
