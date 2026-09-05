CLASS zcl_fixture_rowdefaults DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.

    TYPES: BEGIN OF ty_note,
             title      TYPE string,
             icon_inset TYPE abap_bool,
             selected   TYPE abap_bool,
           END OF ty_note.

    TYPES: BEGIN OF ty_appointment,
             title              TYPE string,
             recurrence_pattern TYPE i,
           END OF ty_appointment.

    DATA t_notes        TYPE STANDARD TABLE OF ty_note WITH DEFAULT KEY.
    DATA t_appointments TYPE STANDARD TABLE OF ty_appointment WITH DEFAULT KEY.
ENDCLASS.

CLASS zcl_fixture_rowdefaults IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    " iconInset defaults to TRUE on sap.m.StandardListItem, and the second row
    " omits it - so that row ships a real false and loses the inset.
    " `selected` is set by NO row, which is ordinary data and stays silent.
    t_notes = VALUE #( ( title = `first`  icon_inset = abap_true )
                       ( title = `second` ) ).

    " recurrence_pattern is unseeded, so it reaches the model as 0 - and
    " RecurringCalendarAppointment.setRecurrencePattern throws below 1
    t_appointments = VALUE #( ( title = `daily` ) ).

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = `View` ns = `mvc`
        )->a( n = `xmlns`     v = `sap.m`
        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`
        )->a( n = `xmlns:u`   v = `sap.ui.unified`
        )->ele( `Page`

          )->ele( `List` )->a( n = `items` v = client->_bind( t_notes )
            )->ele( `StandardListItem`
              )->a( n = `title` v = `{TITLE}`
              )->a( n = `iconInset` v = `{ICON_INSET}`
              )->a( n = `selected` v = `{SELECTED}`
            )->end(
          )->end(

          )->ele( n = `CalendarRow` ns = `u`
            )->a( n = `appointments` v = client->_bind( t_appointments )
            )->ele( n = `appointments` ns = `u`
              )->ele( n = `RecurringCalendarAppointment` ns = `u`
                )->a( n = `title` v = `{TITLE}`
                )->a( n = `recurrencePattern` v = `{RECURRENCE_PATTERN}`
              )->end(
            )->end(
          )->end( ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
